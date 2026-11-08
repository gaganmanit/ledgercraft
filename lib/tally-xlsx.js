import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseTallyXml } from './tally-format.js';
import { tallyDate, tallyAmount } from './tally-values.js';
import { readTallyZip } from './tally-zip.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const local = node => { const colon=node.tag.indexOf(':');return colon<0?node.tag:node.tag.slice(colon+1); };
const direct = (node, name) => node?.children.filter(entry => entry.tag===name || local(entry) === name) || [];
const one = (node, name) => node?.children.find(entry => entry.tag===name || local(entry) === name);
const all = (node, name) => [...direct(node, name), ...(node?.children || []).flatMap(entry => all(entry, name))];
const attr = (node, name) => node?.attrs[name] || '';
const content = node => node ? node.text + node.children.map(content).join('') : '';
const normalize = text => String(text).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const treeNode = (tag, text = '', children = [], attrs = {}) => ({ tag, attrs, text: String(text), children });
const field = (node, tag, text) => { if (text !== undefined && text !== null && text !== '') node.children.push(treeNode(tag, text)); };
const keyValue = (node, name) => one(node, name)?.text || '';
const xml = bytes => {
  if (!bytes) throw new Error('A required XLSX component is missing');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('XLSX XML must use complete UTF-8'); }
  return parseTallyXml(text).children[0];
};

function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a < 0n ? -a : a; }
function rational(n, d = 1n) {
  if (!d) throw new Error('Formula divides by zero');
  if (d < 0n) { n = -n; d = -d; }
  const factor = gcd(n, d); n /= factor; d /= factor;
  if (n.toString().length > 100 || d.toString().length > 100) throw new Error('Formula exceeds the exact decimal limit');
  return { n, d };
}
function decimal(input) {
  const text = String(input), match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || text.length > 100 || Math.abs(Number(match[4] || 0)) > 30) throw new Error('Unsupported Excel numeric value');
  const scale = (match[3] || '').length - Number(match[4] || 0);
  const n = BigInt(match[2] + (match[3] || '')) * (match[1] === '-' ? -1n : 1n);
  return rational(scale < 0 ? n * 10n ** BigInt(-scale) : n, scale > 0 ? 10n ** BigInt(scale) : 1n);
}
function decimalText(value) {
  const negative = value.n < 0n, n = negative ? -value.n : value.n;
  let whole = n / value.d, remainder = n % value.d, fraction = '';
  while (remainder && fraction.length < 18) { remainder *= 10n; fraction += remainder / value.d; remainder %= value.d; }
  if (remainder) throw new Error('Formula result needs unsupported decimal rounding; use an explicit ROUND');
  return (negative ? '-' : '') + whole + (fraction ? '.' + fraction : '');
}
function operation(a, b, op) {
  if (op === '+') return rational(a.n * b.d + b.n * a.d, a.d * b.d);
  if (op === '-') return rational(a.n * b.d - b.n * a.d, a.d * b.d);
  if (op === '*') return rational(a.n * b.n, a.d * b.d);
  return rational(a.n * b.d, a.d * b.n);
}
function columnNumber(text) { let value = 0; for (const char of text) value = value * 26 + char.charCodeAt(0) - 64; return value; }
function columnName(number) { let result = ''; for (; number; number = Math.floor((number - 1) / 26)) result = String.fromCharCode(65 + (number - 1) % 26) + result; return result; }

// An expression interpreter, never JavaScript evaluation. Cached formula values
// remain source evidence; posting values are calculated independently.
function evaluateFormula(formula, get, budget) {
  if (formula.length > 4000) throw new Error('Formula is too long');
  const tokens = formula.replace(/^=/, '').match(/\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_.]*|[+*/(),:\-]|\s+|./g).filter(token => !/^\s+$/.test(token));
  let index = 0, nesting = 0;
  function step() { if (++budget.steps > 100000) throw new Error('Formula calculation exceeds the supported limit'); }
  function reference(token) {
    const ref = token.replaceAll('$', '').toUpperCase();
    if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(ref) || columnNumber(ref.match(/^[A-Z]+/)[0]) > 16384 || Number(ref.match(/\d+$/)[0]) > 1048576) throw new Error('Unsupported formula reference');
    return ref;
  }
  function primary() {
    if (++nesting>128) { nesting--; throw new Error('Formula expression nesting exceeds 128 levels'); }
    try { return primaryValue(); } finally { nesting--; }
  }
  function primaryValue() {
    step(); const token = tokens[index++];
    if (token === '+' || token === '-') { const value = primary(); return token === '-' ? rational(-value.n, value.d) : value; }
    if (token === '(') { const value = expression(); if (tokens[index++] !== ')') throw new Error('Unclosed formula expression'); return value; }
    if (/^\d/.test(token || '')) return decimal(token);
    if (/^\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}$/.test(token || '')) return get(reference(token));
    if (/^(SUM|ROUND)$/i.test(token || '') && tokens[index++] === '(') {
      const name = token.toUpperCase(), args = [];
      do {
        if (name === 'SUM' && /^\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}$/.test(tokens[index] || '') && tokens[index + 1] === ':') {
          const start = reference(tokens[index]); index += 2; const end = reference(tokens[index++]);
          const [sc,sr] = start.match(/^([A-Z]+)(\d+)$/).slice(1), [ec,er] = end.match(/^([A-Z]+)(\d+)$/).slice(1);
          if (columnNumber(sc) > columnNumber(ec) || Number(sr) > Number(er) || (columnNumber(ec)-columnNumber(sc)+1)*(Number(er)-Number(sr)+1)>100000) throw new Error('Formula range exceeds the supported bounds');
          let sum = rational(0n);
          for (let c = columnNumber(sc); c <= columnNumber(ec); c++) for (let r = Number(sr); r <= Number(er); r++) { step(); sum = operation(sum,get(columnName(c)+r),'+'); }
          args.push(sum);
        } else args.push(expression());
        if (tokens[index] !== ',') break; index++;
      } while (true);
      if (tokens[index++] !== ')') throw new Error('Unclosed formula function');
      if (name === 'SUM') return args.reduce((sum, value) => operation(sum,value,'+'),rational(0n));
      if (args.length !== 2 || args[1].d !== 1n || args[1].n < -12n || args[1].n > 12n) throw new Error('ROUND requires an integer decimal-place argument between -12 and 12');
      const places = Number(args[1].n), scale = 10n ** BigInt(Math.abs(places));
      const value = places >= 0 ? rational(args[0].n * scale,args[0].d) : rational(args[0].n,args[0].d * scale);
      const negative = value.n < 0n, n = negative ? -value.n : value.n;
      const rounded = (n / value.d + ((n % value.d)*2n >= value.d ? 1n : 0n)) * (negative ? -1n : 1n);
      return places >= 0 ? rational(rounded,scale) : rational(rounded*scale);
    }
    throw new Error('Unsupported formula; only local arithmetic, SUM and ROUND are calculated');
  }
  function term() { let value = primary(); while (['*','/'].includes(tokens[index])) { const op = tokens[index++]; value = operation(value,primary(),op); } return value; }
  function expression() { let value = term(); while (['+','-'].includes(tokens[index])) { const op = tokens[index++]; value = operation(value,term(),op); } return value; }
  const result = expression();
  if (index !== tokens.length) throw new Error('Unsupported formula syntax or external reference');
  return result;
}

const dateFormats = new Set([14,15,16,17,18,19,20,21,22,27,28,29,30,31,32,33,34,35,36,45,46,47,50,51,52,53,54,55,56,57,58]);
function dateFormat(id, format) {
  const code = format.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '');
  return dateFormats.has(Number(id)) || /[dy]|h.*[ms]/i.test(code);
}
function excelDate(text, date1904) {
  const value = decimal(text), days = Number(value.n) / Number(value.d);
  if (!Number.isFinite(days) || days < 0 || days > 2958465 || (!date1904 && Math.floor(days) === 60)) throw new Error('Invalid or fictitious Excel date');
  const epoch = date1904 ? Date.UTC(1904,0,1) : Date.UTC(1899,11,31);
  const time = epoch + Math.round((days - (!date1904 && days >= 61 ? 1 : 0))*86400000);
  const iso = new Date(time).toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0,10) : iso;
}
function readWorkbook(entries) {
  const types = xml(entries.get('[Content_Types].xml'));
  if ([...entries.keys()].some(name=>/vbaproject|activex|embeddings\//i.test(name)) || all(types,'Override').some(node=>/macroenabled|vba|oleobject|activex/i.test(attr(node,'ContentType')))) throw new Error('Macro-enabled or embedded executable workbooks are not accepted');
  const packageRels = xml(entries.get('_rels/.rels'));
  const office = direct(packageRels,'Relationship').find(node=>/\/officeDocument$/.test(attr(node,'Type')));
  if (!office || attr(office,'TargetMode') === 'External') throw new Error('A local XLSX workbook relationship is required');
  const bookPath = partPath('',attr(office,'Target')), book = xml(entries.get(bookPath));
  const relationPath = path.posix.join(path.posix.dirname(bookPath),'_rels',path.posix.basename(bookPath)+'.rels');
  const relationshipNodes=direct(xml(entries.get(relationPath)),'Relationship');
  if (new Set(relationshipNodes.map(node=>attr(node,'Id'))).size!==relationshipNodes.length) throw new Error('Repeated XLSX relationship identity');
  const relations = new Map(relationshipNodes.map(node=>[attr(node,'Id'),node]));
  const date1904 = /^(1|true)$/i.test(attr(one(book,'workbookPr'),'date1904'));
  const sharedRelation = [...relations.values()].find(node=>/\/sharedStrings$/.test(attr(node,'Type')));
  if (sharedRelation && attr(sharedRelation,'TargetMode')==='External') throw new Error('XLSX shared strings must be inside the workbook');
  const shared = sharedRelation ? direct(xml(entries.get(partPath(bookPath,attr(sharedRelation,'Target')))),'si').map(node=>content(treeNode('text','',node.children.filter(entry=>local(entry)!=='rPh')))) : [];
  const styleRelation = [...relations.values()].find(node=>/\/styles$/.test(attr(node,'Type')));
  if (styleRelation && attr(styleRelation,'TargetMode')==='External') throw new Error('XLSX styles must be inside the workbook');
  const styleRoot = styleRelation ? xml(entries.get(partPath(bookPath,attr(styleRelation,'Target')))) : null;
  const formats = new Map(direct(one(styleRoot,'numFmts'),'numFmt').map(node=>[attr(node,'numFmtId'),attr(node,'formatCode')]));
  const styles = direct(one(styleRoot,'cellXfs'),'xf').map(node=>({id:attr(node,'numFmtId')||'0',format:formats.get(attr(node,'numFmtId'))||''}));
  const sheets = []; let cellCount = 0;
  const names = new Set(), sheetPaths=new Set();
  if (direct(one(book,'sheets'),'sheet').length>64) throw new Error('XLSX exceeds 64 worksheets');
  for (const sheet of direct(one(book,'sheets'),'sheet')) {
    const name = attr(sheet,'name'), rel = relations.get(attr(sheet,'r:id'));
    if (!name || name.length>31 || names.has(name.toLowerCase()) || !rel || attr(rel,'TargetMode') === 'External' || !/\/worksheet$/.test(attr(rel,'Type'))) throw new Error('Unsupported or repeated XLSX worksheet');
    names.add(name.toLowerCase());
    const sheetPath = partPath(bookPath,attr(rel,'Target')), root = xml(entries.get(sheetPath));
    if (sheetPaths.has(sheetPath)) throw new Error('Repeated XLSX worksheet source part');
    sheetPaths.add(sheetPath);
    const cells = new Map(), rows = [], rowNumbers = new Set();
    for (const row of direct(one(root,'sheetData'),'row')) {
      const number = Number(attr(row,'r'));
      if (!Number.isSafeInteger(number) || number < 1 || number > 1048576 || rowNumbers.has(number)) throw new Error('Invalid or repeated XLSX row number');
      rowNumbers.add(number); const rowCells = [], byColumn=[];
      for (const cell of direct(row,'c')) {
        if (++cellCount > 250000) throw new Error('XLSX exceeds 250,000 populated cells');
        const ref = attr(cell,'r').toUpperCase(), match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(ref);
        if (!match || Number(match[2]) !== number || columnNumber(match[1]) > 16384 || cells.has(ref)) throw new Error('Invalid or repeated XLSX cell reference');
        const type = attr(cell,'t') || 'n', style = attr(cell,'s') || '0';
        const formulaNode = one(cell,'f'), formula = formulaNode?.text || '';
        const raw = one(cell,'v')?.text || '', entry = {ref,type,raw,value:'',formula,style,format:styles[Number(style)]?.format || '',column:columnNumber(match[1]),row:number};
        if (formulaNode && Object.keys(formulaNode.attrs).length) entry.error = 'Shared, array and data-table formulas need an explicit ordinary formula';
        if (!['n','s','inlineStr','str','b','e','d'].includes(type)) entry.error = 'Unsupported Excel cell type';
        if (type === 's') {
          if (!/^\d+$/.test(raw) || Number(raw) >= shared.length) throw new Error('Invalid XLSX shared string reference');
          entry.value = shared[Number(raw)];
        } else if (type === 'inlineStr') entry.value = content(one(cell,'is'));
        else if (type === 'b') { if (!['0','1'].includes(raw)) entry.error = 'Invalid Excel boolean'; entry.value = raw === '1' ? 'Yes' : 'No'; }
        else if (type === 'e') entry.error = 'Excel error cell: '+raw;
        else if (type === 'str' || type === 'd') entry.value = raw;
        if (type === 'n' && raw && raw.replace(/^[+-]/,'').replace(/[eE].*$/,'').replace('.','').replace(/^0+|0+$/g,'').length>15) entry.error = 'Excel numeric value exceeds fifteen significant digits; use text for literal identifiers';
        const format = styles[Number(style)]; entry.isDate = type === 'd' || Boolean(format && dateFormat(format.id,format.format));
        if (formulaNode && !formula) entry.error ||= 'Formula text is missing';
        rowCells.push(entry); byColumn[entry.column]=entry; cells.set(ref,entry);
      }
      rows.push({number,cells:rowCells,byColumn});
    }
    rows.sort((a,b)=>a.number-b.number);
    const visiting = new Set(), resolved = new Map(), budget = {steps:0};
    function resolve(ref, depth = 0) {
      if (resolved.has(ref)) return resolved.get(ref);
      if (depth > 128 || visiting.has(ref)) throw new Error('Formula has a circular or excessively deep dependency');
      const cell = cells.get(ref); if (!cell) return rational(0n);
      if (cell.error) throw new Error(cell.error);
      if (!cell.formula && cell.type !== 'n') { if (!cell.value) return rational(0n); throw new Error('Formula refers to a nonnumeric cell'); }
      if (!cell.formula && !cell.raw) return rational(0n);
      visiting.add(ref);
      try {
        const value = cell.formula ? evaluateFormula(cell.formula,target=>resolve(target,depth+1),budget) : decimal(cell.raw);
        resolved.set(ref,value); return value;
      } finally { visiting.delete(ref); }
    }
    for (const cell of cells.values()) {
      if (!cell.formula && cell.type !== 'n' || !cell.raw && !cell.formula || cell.error) continue;
      try {
        cell.value = decimalText(resolve(cell.ref));
        if (cell.isDate) cell.value = excelDate(cell.value,date1904);
        else if (/^0{2,64}$/.test(cell.format) && /^\d+$/.test(cell.value)) cell.value=cell.value.padStart(cell.format.length,'0');
      }
      catch (error) { cell.error = error.message; cell.value = ''; }
    }
    sheets.push({name,path:sheetPath,rows,cells,hidden:attr(sheet,'state') !== '' && attr(sheet,'state') !== 'visible'});
  }
  return {sheets,date1904,cellCount};
}
function partPath(parent, target) {
  if (!target || /[\\\x00-\x1f?#]/.test(target) || /^[A-Za-z]+:/.test(target)) throw new Error('Unsupported XLSX relationship target');
  const result = target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(parent || '.'),target));
  if (result.startsWith('../') || result === '..' || result.startsWith('/')) throw new Error('XLSX relationship escapes the package');
  return result;
}

function sourceRows(sheet, rows, headers, workbookName) {
  return treeNode('XLSXSOURCE','',rows.map(row=>treeNode('XLSXROW','',row.cells.filter(cell=>cell.value!=='' || cell.raw!=='' || cell.formula || cell.error).map(cell=>treeNode('XLSXCELL','',[
    treeNode('HEADER',headers.get(cell.column)||''),treeNode('CELLREF',cell.ref),treeNode('CELLTYPE',cell.type),treeNode('RAWVALUE',cell.raw),treeNode('VALUE',cell.value),treeNode('FORMULA',cell.formula),treeNode('NUMBERFORMAT',cell.format),treeNode('STYLE',cell.style),...(cell.error?[treeNode('ERROR',cell.error)]:[]),
  ])),{INDEX:String(row.number)})),{SHEET:sheet.name});
}
export function tallyXlsxRows(node) {
  const sources=[],pending=[node];
  while(pending.length){const current=pending.pop();if(local(current)==='XLSXSOURCE')sources.push(current);else for(let index=current.children.length-1;index>=0;index--)pending.push(current.children[index]);}
  return sources.flatMap(source=>direct(source,'XLSXROW').map(row=>({sheet:attr(source,'SHEET'),row:Number(attr(row,'INDEX')),cells:direct(row,'XLSXCELL').map(cell=>{
    const values=Object.create(null);for(const entry of cell.children)values[local(entry)]=entry.text;
    return {ref:values.CELLREF||'',header:values.HEADER||'',type:values.CELLTYPE||'',raw:values.RAWVALUE||'',value:values.VALUE||'',formula:values.FORMULA||'',format:values.NUMBERFORMAT||'',style:values.STYLE||'',...(values.ERROR?{error:values.ERROR}:{})};
  })})));
}

const voucherFields = {
  'Voucher Effective Date':'EFFECTIVEDATE','Reference No.':'REFERENCE','Reference Date':'REFERENCEDATE','Voucher Narration':'NARRATION',
  'Buyer/Supplier - Mailing Name':'PARTYMAILINGNAME','Buyer/Supplier - Bill to/from':'PARTYLEDGERNAME','Buyer/Supplier - State':'PARTYSTATENAME',
  'Buyer/Supplier - GSTIN/UIN':'PARTYGSTIN','Buyer/Supplier - Place of Supply':'PLACEOFSUPPLY','Buyer/Supplier - Country':'COUNTRYNAME',
  'Buyer/Supplier - Pincode':'PINCODE','Buyer/Supplier - GST Registration Type':'GSTREGISTRATIONTYPE','GST Registration':'GSTREGISTRATION',
  'Change Mode':'PERSISTEDVIEW','e-Way Bill No.':'EWAYBILLNUMBER','e-Way Bill Date':'EWAYBILLDATE',
  'e-Invoice - Ack No.':'IRNACKNO','e-Invoice - Ack Date':'IRNACKDATE','e-Invoice - IRN':'IRN',
  'e-Way Bill Transport Details - Transporter Name':'TRANSPORTERNAME','e-Way Bill Transport Details - Transporter ID':'TRANSPORTERID',
  'e-Way Bill Transport Details - Mode':'TRANSPORTMODE','e-Way Bill Transport Details - Vehicle Number':'VEHICLENUMBER',
  'e-Way Bill Transport Details - Doc/Lading/RR/Airway No.':'TRANSPORTDOCNO','e-Way Bill Transport Details - Doc/Lading/RR/Airway Date':'TRANSPORTDOCDATE',
  'Port Code':'PORTCODE','Shipping Bill No.':'SHIPPINGBILLNO','Shipping Bill Date':'SHIPPINGBILLDATE',
  'Original Invoice No.':'ORIGINALINVOICENO','Original Invoice - Date':'ORIGINALINVOICEDATE',
};
const statusFields = {Optional:'ISOPTIONAL','Is Optional':'ISOPTIONAL','Post-Dated':'ISPOSTDATED','Is Post Dated':'ISPOSTDATED',Cancelled:'ISCANCELLED','Is Cancelled':'ISCANCELLED',Deleted:'ISDELETED','Is Deleted':'ISDELETED'};
const ledgerFields = {'Group Name':'PARENT','Under':'PARENT','Address':'ADDRESS','State':'LEDSTATENAME','Country':'COUNTRYNAME','Pincode':'PINCODE','Mailing Name':'MAILINGNAME','E-mail':'EMAIL','Phone No.':'LEDGERPHONE','Primary Mobile No.':'LEDGERMOBILE','Currency of Ledger':'CURRENCYNAME','Maintain balances bill-by-bill':'ISBILLWISEON','GST Registration - GSTIN/UIN':'GSTREGISTRATIONNUMBER','GSTIN/UIN':'GSTREGISTRATIONNUMBER'};
const stockFields = {'Group Name':'PARENT','Under':'PARENT','Units':'BASEUNITS','Base Units':'BASEUNITS','Alternate units':'ADDITIONALUNITS','Category':'CATEGORY','Opening Balance - Quantity':'OPENINGBALANCE','Opening Balance - Rate':'OPENINGRATE','Opening Balance - Value':'OPENINGVALUE','Costing Method':'COSTINGMETHOD','Maintain in Batches':'ISBATCHWISEON','Track date of manufacturing':'ISPERISHABLEON','Treat all purchases as consumed':'TREATALLPURCHASESASCONSUMED'};
const headerMap = entries => new Map(Object.entries(entries).map(([key,value])=>[normalize(key),value]));
const voucherMap=headerMap(voucherFields),ledgerMap=headerMap(ledgerFields),stockMap=headerMap(stockFields),statusMap=headerMap(statusFields);
const statusGroups=[...new Set(statusMap.values())].map(tag=>[tag,[...statusMap].filter(([,value])=>value===tag).map(([header])=>header)]);
const identifierFields=[['IRN','e-Invoice - IRN',/^[a-f0-9]{64}$/i],['IRNACKNO','e-Invoice - Ack No.',/^\d{15}$/],['EWAYBILLNUMBER','e-Way Bill No.',/^\d{12}$/]].map(([tag,header,pattern])=>({tag,header,key:normalize(header),pattern}));

function signedAmount(text, direction) {
  if (!text) throw new Error('An accounting amount is missing or unresolved');
  const amount = tallyAmount(text);
  if (!/^(Dr|Cr)$/i.test(direction)) throw new Error('A ledger amount requires an explicit Dr/Cr field');
  if (amount < 0) throw new Error('Negative amounts together with Dr/Cr need source sign review');
  const paise = BigInt(amount), magnitude = (paise/100n)+'.'+String(paise%100n).padStart(2,'0');
  return (/^Dr$/i.test(direction) && amount ? '-' : '')+magnitude;
}
function documentDate(text) {
  if (/T/.test(text)) {
    if (!text.endsWith('T00:00:00.000Z')) throw new Error('Voucher dates with a time component require source review');
    text = text.slice(0,10);
  }
  return tallyDate(text).replaceAll('-','');
}

function worksheetKind(sheet) {
  if (/read\s*me|instruction|help/i.test(sheet.name)) return {kind:'reference',headers:new Map(),start:0};
  for (let index=0;index<Math.min(sheet.rows.length,20);index++) {
    const row=sheet.rows[index], headers=new Map(row.cells.filter(cell=>cell.value).map(cell=>[cell.column,cell.value]));
    const keys=new Set([...headers.values()].map(normalize));
    if (keys.has('voucherdate') && keys.has('vouchertypename') && keys.has('ledgername')) return {kind:'voucher',headers,start:index+1};
    if (/^ledger(?:s)?$/i.test(sheet.name.trim()) && keys.has('name') && (keys.has('groupname')||keys.has('under'))) return {kind:'ledger',headers,start:index+1};
    if (/^stock\s*item(?:s)?$/i.test(sheet.name.trim()) && keys.has('name') && (keys.has('units')||keys.has('baseunits'))) return {kind:'stock',headers,start:index+1};
  }
  return {kind:'unsupported',headers:new Map(),start:0};
}

export function parseTallyXlsx(input, {name='Workbook.xlsx'} = {}) {
  let entries=readTallyZip(input), workbookName=name, encoding='xlsx';
  if (!entries.has('[Content_Types].xml')) {
    const files=[...entries].filter(([entry])=>!entry.endsWith('/'));
    if (files.length!==1 || !/\.xlsx$/i.test(files[0][0])) throw new Error('An outer supplier ZIP must contain exactly one XLSX workbook');
    workbookName=files[0][0]; entries=readTallyZip(files[0][1]); encoding='xlsx-zip';
  }
  const workbook=readWorkbook(entries), issues=[];
  const issue=(severity,code,message,reference='')=>issues.push({severity,code,message,reference});
  const root=treeNode('DOCUMENT','',[treeNode('TALLYMESSAGE')]), message=root.children[0];
  const semantic=digest(JSON.stringify(workbook.sheets.filter(sheet=>!/^.*read\s*me.*$/i.test(sheet.name)).map(sheet=>[sheet.name,sheet.rows.map(row=>[row.number,row.cells.map(cell=>[cell.ref,cell.type,cell.raw,cell.value,cell.formula])])])));
  let voucherCount=0;
  const identifierReferences=new WeakMap();
  const metadata=[];
  for (const sheet of workbook.sheets) {
    const {kind,headers,start}=worksheetKind(sheet);
    const columnCount=sheet.rows.reduce((maximum,row)=>row.cells.reduce((value,cell)=>Math.max(value,cell.column),maximum),0);
    metadata.push({name:sheet.name,rows:sheet.rows.length,columns:columnCount,kind});
    if (kind==='reference') continue;
    const normalizedHeaders=new Map([...headers].map(([column,header])=>[column,normalize(header)]));
    const headerKeys=[...normalizedHeaders.values()];
    const columnsByHeader=new Map([...normalizedHeaders].map(([column,key])=>[key,column]));
    const queryKeys=new Map();
    const queryKey=header=>{let key=queryKeys.get(header);if(key===undefined){key=normalize(header);queryKeys.set(header,key);}return key;};
    const rowCell=(row,key)=>row.byColumn[columnsByHeader.get(key)];
    const rowValue=(row,header)=>rowCell(row,queryKey(header))?.value || '';
    const rowHas=(row,header)=>{const cell=rowCell(row,queryKey(header));return Boolean(cell&&(cell.raw!==''||cell.value!==''||cell.formula));};
    if (new Set(headerKeys).size!==headerKeys.length) issue('blocking','xlsx-duplicate-header',`${sheet.name} has repeated field headers`,sheet.name);
    if (kind==='unsupported') {
      message.children.push(treeNode('XLSXWORKSHEET','',[sourceRows(sheet,sheet.rows,headers,workbookName)],{NAME:sheet.name}));
      if (sheet.rows.some(row=>row.cells.some(cell=>cell.value||cell.raw))) issue('review','xlsx-unmapped-worksheet',`${sheet.name} is retained as source; its column layout has no supported Tally default mapping`,sheet.name);
      continue;
    }
    const unknownStatusColumns=new Set([...normalizedHeaders].filter(([,key])=>/status|optional|cancelled|deleted|postdated/.test(key)&&!statusMap.has(key)).map(([column])=>column));
    const currencyColumns=new Set([...normalizedHeaders].filter(([,key])=>/currency|forex|exchangerate|rateofexchange/.test(key)).map(([column])=>column));
    const groups=[];
    for (const row of sheet.rows.slice(start)) {
      if (!row.cells.some(cell=>cell.value!==''||cell.raw!==''||cell.formula||cell.error)) continue;
      for (const cell of row.cells.filter(cell=>cell.error)) issue('blocking','xlsx-unresolved-cell',`${sheet.name}!${cell.ref}: ${cell.error}`,`${sheet.name}!${cell.ref}`);
      for (const cell of row.cells.filter(cell=>!headers.has(cell.column) && (cell.value!==''||cell.raw!==''||cell.formula))) issue('blocking','xlsx-unheaded-data',`${sheet.name}!${cell.ref} contains data without a field header`,`${sheet.name}!${cell.ref}`);
      for (const cell of row.cells.filter(cell=>unknownStatusColumns.has(cell.column)&&cell.value)) issue('blocking','xlsx-unmapped-status',`${sheet.name}!${cell.ref}: status-bearing field ${headers.get(cell.column)} requires a supported explicit mapping`,`${sheet.name}!${cell.ref}`);
      for (const cell of row.cells.filter(cell=>currencyColumns.has(cell.column)&&cell.value&&!/^(INR|₹|Rs\.?|Indian Rupees?|1(?:\.0+)?)$/i.test(cell.value.trim()))) issue('blocking','xlsx-currency-review',`${sheet.name}!${cell.ref}: foreign-currency or exchange-rate fields need an explicit INR base-currency projection`,`${sheet.name}!${cell.ref}`);
      const begins=kind==='voucher' ? ['Voucher Date','Voucher Type Name','Voucher Number'].some(header=>rowHas(row,header)) : rowHas(row,'Name');
      if (begins) groups.push([]);
      if (!groups.length) { issue('blocking','xlsx-orphan-row',`${sheet.name} row ${row.number} has no preceding ${kind==='voucher'?'voucher':'master'} identity`,`${sheet.name}!${row.number}`); groups.push([]); }
      groups.at(-1).push(row);
    }
    for (let groupIndex=0;groupIndex<groups.length;groupIndex++) {
      const rows=groups[groupIndex], first=rows[0], reference=`${sheet.name}!${first.number}`;
      const node=treeNode(kind==='voucher'?'VOUCHER':kind==='ledger'?'LEDGER':'STOCKITEM');
      node.children.push(sourceRows(sheet,rows,headers,workbookName));
      const firstValue=header=>{for(const row of rows){const text=rowValue(row,header);if(text)return text;}return '';};
      try {
        if (kind==='voucher') {
          voucherCount++; field(node,'GUID',`xlsx-${semantic.slice(0,32)}-${metadata.length}-${groupIndex}`);
          field(node,'DATE',documentDate(rowValue(first,'Voucher Date'))); field(node,'VOUCHERTYPENAME',rowValue(first,'Voucher Type Name'));
          field(node,'VOUCHERNUMBER',rowValue(first,'Voucher Number'));
          if (!rowValue(first,'Voucher Type Name')) throw new Error('Voucher Type Name is required at each new voucher');
          const mapped=voucherMap;
          for (const [header,tag] of mapped) {
            if(!columnsByHeader.has(header))continue;
            const values=rows.map(row=>rowCell(row,header)?.value).filter(Boolean);
            if (new Set(values).size>1 && !['NARRATION'].includes(tag)) throw new Error(`Conflicting ${tag} values within one voucher`);
            if (values.length) field(node,tag,tag==='EFFECTIVEDATE'?documentDate(values[0]):tag==='NARRATION'?values.join('\n'):values[0]);
          }
          for (const [tag,keys] of statusGroups) {
            const values=[...new Set(keys.filter(key=>columnsByHeader.has(key)).flatMap(key=>rows.map(row=>rowCell(row,key)?.value)).filter(Boolean).map(text=>{
              if (!/^(yes|no|true|false|0|1)$/i.test(text)) throw new Error(`Unknown ${tag} status ${text}`);
              return /^(yes|true|1)$/i.test(text)?'Yes':'No';
            }))];
            if (values.length>1) throw new Error(`Conflicting ${tag} statuses within one voucher`);
            field(node,tag,values[0]);
          }
          for (const row of rows) field(node,'ADDRESS',rowValue(row,'Buyer/Supplier - Address'));
          const type=rowValue(first,'Voucher Type Name').toLowerCase(), incoming=/^(purchase|credit note|receipt note|rejections in|purchase order)$/.test(type);
          const directionKnown=incoming||/^(sales|debit note|delivery note|rejections out|sales order)$/.test(type);
          let currentPosting=null;
          const postings=[], itemGroups=[];
          for (const row of rows) {
            const ledgerName=rowValue(row,'Ledger Name');
            if (ledgerName) {
              const posting=treeNode('ALLLEDGERENTRIES.LIST');
              field(posting,'LEDGERNAME',ledgerName); field(posting,'AMOUNT',signedAmount(rowValue(row,'Ledger Amount'),rowValue(row,'Ledger Amount Dr/Cr')));
              field(posting,'ISDEEMEDPOSITIVE',/^Dr$/i.test(rowValue(row,'Ledger Amount Dr/Cr'))?'Yes':'No'); field(posting,'NARRATION',rowValue(row,'Ledger Narration'));
              field(posting,'XLSXROWNUMBER',row.number); node.children.push(posting); postings.push(posting); currentPosting={node:posting,items:[]}; itemGroups.push(currentPosting);
            } else if (rowHas(row,'Ledger Amount') || rowHas(row,'Ledger Amount Dr/Cr')) throw new Error(`Ledger amount has no ledger name at row ${row.number}`);
            const itemName=rowValue(row,'Item Name');
            if (itemName) {
              const item=treeNode('ALLINVENTORYENTRIES.LIST'), unit=rowValue(row,'Quantity UOM')||rowValue(row,'Item Rate per');
              field(item,'STOCKITEMNAME',itemName); field(item,'XLSXROWNUMBER',row.number);
              field(item,'BILLEDQTY',rowValue(row,'Billed Quantity')+(rowValue(row,'Billed Quantity')&&unit?' '+unit:''));
              if (rowHas(row,'Actual Quantity')) field(item,'ACTUALQTY',rowValue(row,'Actual Quantity')+(unit?' '+unit:''));
              field(item,'RATE',rowValue(row,'Item Rate')+(unit?'/'+unit:''));
              const amount=signedAmount(rowValue(row,'Item Amount'),incoming?'Dr':'Cr');
              field(item,'AMOUNT',amount); if (directionKnown) field(item,'ISDEEMEDPOSITIVE',incoming?'Yes':'No');
              else issue('review','xlsx-item-direction-unknown',`${reference}: ${type} does not establish this item's physical stock direction; the source quantity remains available`,reference);
              field(item,'DESCRIPTION',rowValue(row,'Item Description'));
              if (currentPosting) {
                const allocation=treeNode('ACCOUNTINGALLOCATIONS.LIST');
                field(allocation,'LEDGERNAME',keyValue(currentPosting.node,'LEDGERNAME'));field(allocation,'AMOUNT',amount);field(allocation,'ISDEEMEDPOSITIVE',incoming?'Yes':'No');
                field(allocation,'XLSXPOSTINGROW',keyValue(currentPosting.node,'XLSXROWNUMBER'));item.children.push(allocation); currentPosting.items.push(item);
              } else issue('review','xlsx-item-account-unknown',`${reference}: ${itemName} has no preceding source ledger allocation`,reference);
              node.children.push(item);
            }
            if (currentPosting && rowValue(row,'Bill Name')) {
              const bill=treeNode('BILLALLOCATIONS.LIST');
              field(bill,'NAME',rowValue(row,'Bill Name'));field(bill,'BILLTYPE',rowValue(row,'Bill Type of Ref'));
              field(bill,'AMOUNT',signedAmount(rowValue(row,'Bill Amount'),rowValue(row,'Bill Amount - Dr/Cr')));field(bill,'BILLCREDITPERIOD',rowValue(row,'Bill Due Dt or Credit Days'));
              currentPosting.node.children.push(bill);
            }
          }
          for (const group of itemGroups.filter(group=>group.items.length)) {
            const sum=group.items.reduce((total,item)=>total+BigInt(tallyAmount(keyValue(item,'AMOUNT'))),0n);
            if (sum!==BigInt(tallyAmount(keyValue(group.node,'AMOUNT')))) {
              for (const item of group.items) item.children=item.children.filter(entry=>entry.tag!=='ACCOUNTINGALLOCATIONS.LIST');
              issue('review','xlsx-item-account-unreconciled',`${reference}: item amounts do not reconcile to the contiguous ${keyValue(group.node,'LEDGERNAME')} ledger row; allocation remains in the original source`,reference);
            } else field(group.node,'XLSXROLE','item-account');
          }
          // Party fields in the default template describe the first ledger entry.
          if (!keyValue(node,'PARTYLEDGERNAME') && postings.length && /^(sales|purchase|credit note|debit note)$/.test(type)) field(node,'PARTYLEDGERNAME',keyValue(postings[0],'LEDGERNAME'));
          if (postings.length && keyValue(postings[0],'LEDGERNAME')===keyValue(node,'PARTYLEDGERNAME')) field(postings[0],'XLSXROLE','party');
          if (!keyValue(node,'PARTYMAILINGNAME') && keyValue(node,'PARTYLEDGERNAME')) field(node,'PARTYMAILINGNAME',keyValue(node,'PARTYLEDGERNAME'));
        } else {
          const name=rowValue(first,'Name'); if (!name) throw new Error('Master Name is missing'); node.attrs.NAME=name;
          const mapped=kind==='ledger'?ledgerMap:stockMap;
          for (const tag of new Set(mapped.values())) {
            const values=[...new Set(rows.flatMap(row=>row.cells.filter(cell=>mapped.get(normalizedHeaders.get(cell.column))===tag).map(cell=>cell.value)).filter(Boolean))];
            if (values.length>1 && tag!=='ADDRESS') throw new Error(`Conflicting ${tag} values within one master`);
            for (const text of values) field(node,tag,text);
          }
          if (kind==='ledger') {
            const opening=firstValue('Ledger - Opening Balance');
            if (opening) field(node,'OPENINGBALANCE',signedAmount(opening,firstValue('Ledger Opening Balance - Dr/Cr')));
            else field(node,'XLSXOPENINGUNKNOWN','Yes');
            for (const row of rows.filter(row=>rowValue(row,'Bill - Name'))) {
              const bill=treeNode('BILLALLOCATIONS.LIST'); field(bill,'NAME',rowValue(row,'Bill - Name'));
              field(bill,'BILLDATE',documentDate(rowValue(row,'Bill - Date')));field(bill,'AMOUNT',signedAmount(rowValue(row,'Bill - Amount'),rowValue(row,'Bill Amount - Dr/Cr')));node.children.push(bill);
            }
          }
          if (kind==='stock') {
            if (!firstValue('Opening Balance - Quantity')&&!firstValue('Opening Balance - Value')) field(node,'XLSXOPENINGUNKNOWN','Yes');
            if ([...headers.values()].some(header=>/price\s*list|standard\s*(selling|cost)|bom/i.test(header))) issue('review','xlsx-stock-schedules-retained',`${name}: price schedules, standard costs and other advanced fields remain source evidence`,reference);
          }
        }
      } catch (error) { field(node,'XLSXPARSEERROR',error.message); issue('blocking','xlsx-record-mapping',`${reference}: ${error.message}`,reference); }
      if(kind==='voucher'){
        const references=new Map();
        for(const {tag,key} of identifierFields)for(const row of rows){const cell=rowCell(row,key);if(cell?.value){references.set(tag,`${sheet.name}!${cell.ref}`);break;}}
        identifierReferences.set(node,references);
      }
      message.children.push(node);
    }
  }
  if (!message.children.some(node=>['VOUCHER','LEDGER','STOCKITEM'].includes(node.tag))) issue('blocking','xlsx-no-default-records','No supported Tally default voucher or master worksheet was found',name);
  const diagnostics=[];
  for (const {tag,header,pattern} of identifierFields) {
    const occurrences=new Map();
    for (const node of message.children.filter(node=>node.tag==='VOUCHER')) {
      const identifier=keyValue(node,tag);if (!identifier) continue;
      const reference=identifierReferences.get(node)?.get(tag)||keyValue(node,'VOUCHERNUMBER');
      if (!pattern.test(identifier)) { issue('review','xlsx-invalid-'+tag.toLowerCase(),`${reference}: ${header} does not match its expected identifier format; its original cell remains source evidence`,reference);diagnostics.push({code:'xlsx-invalid-'+tag.toLowerCase(),field:tag,value:identifier,reference}); }
      const key=tag==='IRN'?identifier.toLowerCase():identifier;
      if (!occurrences.has(key)) occurrences.set(key,[]);
      occurrences.get(key).push({number:keyValue(node,'VOUCHERNUMBER'),date:keyValue(node,'DATE'),reference});
    }
    for (const [identifier,vouchers] of occurrences) if (vouchers.length>1) {
      const code='xlsx-duplicate-'+tag.toLowerCase();
      issue('review',code,`${header} is repeated on ${vouchers.length} source vouchers (${vouchers.map(voucher=>voucher.number).join(', ')}). Retained identifiers do not establish distinct authenticated portal records`,vouchers.map(voucher=>voucher.reference).join(', '));
      diagnostics.push({code,field:tag,value:identifier,vouchers});
    }
  }
  if ([...entries].filter(([entry,bytes])=>entry.endsWith('.rels') && /TargetMode\s*=\s*["']External["']/.test(bytes.toString('utf8'))).length) issue('info','xlsx-external-links-not-followed','Workbook external links remain archived; none were opened',name);
  return {tree:root,issues,encoding,workbook:{containerName:name,workbookName,date1904:workbook.date1904,sheets:metadata,voucherCount,cellCount:workbook.cellCount,diagnostics}};
}
