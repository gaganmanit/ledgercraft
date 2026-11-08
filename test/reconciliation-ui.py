"""Local synthetic-fixture UI regression. Supply the JSON produced by the isolated test server."""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

fixture = json.loads(Path(sys.argv[1]).read_text())
output = Path(sys.argv[2]); output.mkdir(parents=True, exist_ok=True)
base, company_id = fixture['url'], fixture['id']
assert base.startswith('http://127.0.0.1:')
api = f'/api/companies/{company_id}'
book = f'{base}/#/c/{company_id}'

def request(path, body=None, method=None):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None,
        method=method or ('POST' if body is not None else 'GET'), headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req) as response: return json.load(response)
    except urllib.error.HTTPError as error:
        return {'status':error.code, **json.load(error)}

initial = request(api)
assert initial['company']['name'] == 'Synthetic Reconciliation Books'
original_vouchers = initial['vouchers']
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('LEDGERCRAFT_TEST_BROWSER') or os.environ.get('FINANCER_TEST_BROWSER'), headless=True,
        args=['--disable-gpu','--disable-background-networking','--disable-component-update','--disable-default-apps','--disable-domain-reliability','--disable-sync','--metrics-recording-only','--no-first-run'])
    context = browser.new_context(viewport={'width':1360,'height':1024})
    context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(base+'/') else route.abort())
    page = context.new_page(); page.set_default_timeout(15000); expect.set_options(timeout=15000)
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        page.goto(book+'/bank-reconciliation')
        expect(page.locator('h1')).to_have_text('Bank reconciliation')
        form = page.locator('#bank-statement-import')
        form.locator('[name=file]').set_input_files(str(Path(fixture['home'])/'statement.csv'))
        expect(form.locator('[name=mapDate]')).to_have_value('0')
        expect(form.locator('[name=amountMode]')).to_have_value('split')
        form.locator('[name=from]').fill('2026-04-01'); form.locator('[name=to]').fill('2026-04-30')
        form.locator('[name=opening]').fill('1000.00'); form.locator('[name=closing]').fill('1020.00')
        form.get_by_role('button',name='Preview statement',exact=True).click()
        expect(form.locator('[data-statement-preview]')).to_contain_text('2 transaction rows')
        form.get_by_role('button',name='Import for review',exact=True).click()
        expect(page.get_by_text('Statement imported for reconciliation.',exact=True)).to_be_visible()
        expect(page.locator('[data-statement-rows]')).to_contain_text('Customer, A')
        state=request(api+'/reconciliation/bank')
        assert len(state['statements'])==1
        statement_id=state['statements'][0]['id']
        state=request(api+f'/reconciliation/bank?statementId={statement_id}')
        assert len(state['matches'])==0
        assert state['totals']['differencePaise']==0
        print('CSV mapped, imported and retained for explicit review',flush=True)
        page.get_by_role('button',name=re.compile('Select RCT-001')).click()
        page.get_by_role('button',name='Confirm selected match',exact=True).click()
        expect(page.get_by_text('Selected transactions matched.',exact=True)).to_be_visible()
        expect(page.locator('[data-confirmed-matches]')).to_contain_text('RCT-001')
        page.get_by_role('button',name='Unmatch',exact=True).click()
        expect(page.get_by_text('Bank match removed.',exact=True)).to_be_visible()
        page.get_by_role('button',name=re.compile('Select RCT-001')).click()
        page.get_by_role('button',name='Confirm selected match',exact=True).click()
        expect(page.get_by_text('Selected transactions matched.',exact=True)).to_be_visible()
        page.screenshot(path=str(output/'bank-reconciliation.png'),full_page=True)
        print('Explicit match, unmatch and rematch passed',flush=True)

        page.get_by_text('Import bank statement CSV',exact=True).click()
        form=page.locator('#bank-statement-import')
        form.locator('[name=file]').set_input_files(str(Path(fixture['home'])/'statement.csv'))
        expect(form.locator('[name=amountMode]')).to_have_value('split')
        form.locator('[name=from]').fill('2026-04-01'); form.locator('[name=to]').fill('2026-04-30')
        form.locator('[name=opening]').fill('1000.00'); form.locator('[name=closing]').fill('1020.00')
        form.get_by_role('button',name='Preview statement',exact=True).click()
        form.get_by_role('button',name='Import for review',exact=True).click()
        expect(form.locator('[data-import-error]')).to_contain_text('already been imported')
        assert len(request(api+'/reconciliation/bank')['statements'])==1
        form.locator('[name=file]').set_input_files(str(Path(fixture['home'])/'signed.csv'))
        expect(form.locator('[name=amountMode]')).to_have_value('signed')
        expect(form.locator('[name=mapAmount]')).to_have_value('2')
        form.locator('[name=from]').fill('2026-05-01'); form.locator('[name=to]').fill('2026-05-31')
        form.locator('[name=opening]').fill('1020.00'); form.locator('[name=closing]').fill('1017.00')
        form.get_by_role('button',name='Preview statement',exact=True).click()
        expect(form.locator('[data-statement-preview]')).to_contain_text('3.00')
        form.get_by_role('button',name='Import for review',exact=True).click()
        expect(page.get_by_text('Statement imported for reconciliation.',exact=True)).to_be_visible()
        expect(page.locator('[data-statement-rows]')).to_contain_text('FEE-001')
        assert len(request(api+'/reconciliation/bank')['statements'])==2
        print('Duplicate import refused; signed amount and placeholders mapped correctly',flush=True)

        page.goto(book+'/bill-outstanding')
        expect(page.locator('h1')).to_have_text('Bill-wise outstanding')
        page.get_by_text('Create bill reference',exact=True).click()
        reference=page.locator('#bill-reference-form')
        source=reference.locator('[name=sourceKey] option').filter(has_text='INV-001').first.get_attribute('value')
        reference.locator('[name=sourceKey]').select_option(source)
        reference.locator('[name=reference]').fill('INV-001')
        reference.locator('[name=dueDate]').fill('2026-04-10')
        reference.locator('[name=amount]').fill('100.00')
        reference.get_by_role('button',name='Save reference',exact=True).click()
        expect(page.get_by_text('Bill reference saved.',exact=True)).to_be_visible()
        page.get_by_text('Allocate a settlement against a bill',exact=True).click()
        allocation=page.locator('#bill-allocation-form')
        bill_id=allocation.locator('[name=billId] option').filter(has_text='INV-001').first.get_attribute('value')
        allocation.locator('[name=billId]').select_option(bill_id)
        credit=allocation.locator('[name=creditKey] option').filter(has_text='RCT-001').first.get_attribute('value')
        allocation.locator('[name=creditKey]').select_option(credit)
        expect(allocation.locator('[name=amount]')).to_have_value('60.00')
        allocation.get_by_role('button',name='Save allocation',exact=True).click()
        expect(page.get_by_text('Settlement allocated to bill.',exact=True)).to_be_visible()
        report=request(api+'/reconciliation/bills?asOf=2026-11-08')
        target=next(row for row in report['rows'] if row['reference']=='INV-001')
        assert target['openPaise']==4000 and target['bucket']=='90+'
        assert all(row['differencePaise']==0 for row in report['totals'])
        assert len(report['allocations'])==1
        page.reload()
        expect(page.locator('[data-allocation-rows]')).to_contain_text('RCT-001')
        expect(page.locator('[data-allocation-rows]')).to_contain_text('INV-001')
        page.screenshot(path=str(output/'bill-outstanding.png'),full_page=True)
        page.emulate_media(media='print'); page.pdf(path=str(output/'bill-outstanding.pdf'),format='A4',print_background=True); page.emulate_media(media='screen')
        page.get_by_role('button',name='Remove allocation',exact=True).click()
        expect(page.get_by_text('Allocation removed.',exact=True)).to_be_visible()
        report=request(api+'/reconciliation/bills?asOf=2026-11-08')
        assert len(report['allocations'])==0
        assert next(row for row in report['rows'] if row['reference']=='INV-001')['openPaise']==10000
        assert request(api)['vouchers']==original_vouchers
        print('Bill due date, partial allocation, ageing, reload, trace and unallocation passed',flush=True)

        backup=request(api+'/backup')
        assert backup['company']['reconciliation']['statements'][0]['sourceCsv']==(Path(fixture['home'])/'statement.csv').read_bytes().decode()
        restored=request('/api/import',backup)
        assert 'company' in restored,restored
        restored_report=request('/api/companies/'+restored['company']['id']+'/reconciliation/bills?asOf=2026-11-08')
        assert all(row['differencePaise']==0 for row in restored_report['totals'])
        print('Company backup and restore preserved raw statement and allocation history',flush=True)

        page.goto(book+'/gst-exchange/'+fixture['invoice'])
        expect(page.locator('h1')).to_have_text('E-invoice & e-way bill')
        expect(page.locator('#exchange-preparation')).to_be_visible()
        assert page.get_by_role('button',name='Save preparation',exact=True).count()==1
        assert page.locator('[data-download=irp]').count()==1
        assert page.locator('[data-download=ewaybill]').count()==1
        preparation=page.locator('#exchange-preparation')
        for section in ['seller','buyer']:
            preparation.locator(f'[name="{section}.location"]').fill('Bhopal')
            preparation.locator(f'[name="{section}.pincode"]').fill('462001')
        preparation.locator('[name="transport.distanceKm"]').fill('12')
        preparation.locator('[name="transport.vehicleNo"]').fill('MP04AB1234')
        preparation.get_by_role('button',name='Save preparation',exact=True).click()
        expect(page.get_by_text('1 saved version',exact=True)).to_be_visible()
        for kind, filename in [('irp','irp-bulk.json'),('ewaybill','ewaybill-request.json')]:
            link=page.locator(f'[data-download={kind}]')
            expect(link).to_have_attribute('href',re.compile('/'+kind+'$'))
            with page.expect_download() as downloaded: link.click()
            downloaded.value.save_as(str(output/filename))
            assert json.loads((output/filename).read_text())
        assert [row['lines'] for row in request(api)['vouchers']]==[row['lines'] for row in original_vouchers]
        print('Exchange preparation, native download links and local payloads passed',flush=True)
        assert not errors,errors
        result={'passed':True,'bankStatements':2,'confirmedMatchCount':1,'billOpenAfterPartialPaise':4000,'billOpenAfterUnallocatePaise':10000,'ledgerPostingsUnchanged':True,'backupRestore':True,'exchangeSmoke':True,'pageErrors':errors}
        (output/'results.json').write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps(result),flush=True)
    except Exception as error:
        print('UI FAILURE '+repr(error)+' PAGE ERRORS '+json.dumps(errors),flush=True)
        if not page.is_closed():
            page.screenshot(path=str(output/'failure.png'),full_page=True)
            (output/'failure-dom.txt').write_text(page.locator('body').inner_text())
        raise
    finally:
        context.close(); browser.close()
