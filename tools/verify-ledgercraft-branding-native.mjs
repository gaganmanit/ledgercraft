import assert from 'node:assert/strict';
import {runNative} from './native-command.mjs';
import {createHash} from 'node:crypto';
import {cp,mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sourceRoot=path.resolve(process.env.FINANCER_NATIVE_BOOK_RESOURCES||root);
const output=path.resolve(process.argv[2]||path.join(root,'output','ledgercraft-branding-native'));
const scratch=await mkdtemp(path.join(tmpdir(),'ledgercraft-branding-'));
await mkdir(output,{recursive:true});
const run=args=>runNative(args,root);
let server;
try{
 const frozen=path.join(scratch,'source');await mkdir(frozen);
 for(const name of ['package.json','server.js','lib','public'])await cp(path.join(sourceRoot,name),path.join(frozen,name),{recursive:true});
 const {start}=await import(pathToFileURL(path.join(frozen,'server.js')));server=await start({dataDir:path.join(scratch,'data')});
 const base=`http://127.0.0.1:${server.address().port}`,config=path.join(scratch,'fixture.json'),swift=path.join(scratch,'branding.swift'),executable=path.join(scratch,'branding-ui');
 await writeFile(config,JSON.stringify({base,output}));await cp(path.join(root,'test/ledgercraft-branding-ui.swift'),swift);
 await run(['/usr/bin/swiftc','-swift-version','5',swift,'-o',executable,'-framework','AppKit','-framework','WebKit']);await run([executable,config]);
 const native=JSON.parse(await readFile(path.join(output,'native-results.json'),'utf8'));assert.equal(native.passed,true);
 const sourceSHA256ByFile={};for(const file of ['public/app.js','public/book-tools.js','public/tally-tools.js','public/finder.js','public/index.html','public/ledgercraft.css','public/favicon.svg','public/tally-bridge.ps1'])sourceSHA256ByFile[file]=createHash('sha256').update(await readFile(path.join(frozen,file))).digest('hex');
 await writeFile(path.join(output,'source-proof.json'),JSON.stringify({passed:true,sourceRoot,sourceSHA256ByFile,internalDataDirectoryUnaffected:true},null,2));
 console.log(`Ledgercraft native branding proof saved to ${output}`);
}finally{if(server){server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));}await rm(scratch,{recursive:true,force:true});}
