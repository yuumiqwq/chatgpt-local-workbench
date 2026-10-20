import assert from 'node:assert/strict';
import test from 'node:test';
import { inputFocusProof } from '../../src/phone/focus.js';

const dump = `Input method service state for org.workbench.ime.WorkbenchIme@abc:
  mStartedInputConnection=RemoteInputConnection{idHash=#123}
  mInputStarted=true mInputViewStarted=true
  mInputEditorInfo:
    inputType=0x1 imeOptions=0x10000006
    hintText=private hint
    packageName=com.example.app autofillId=123 fieldId=-1
  mShowInputRequested=true`;
test('IME focus fingerprint ignores hints but changes with the actual editor connection', () => {
  const proof = inputFocusProof(dump,'com.example.app');
  assert.match(proof!,/^[a-f0-9]{64}$/);
  assert.equal(inputFocusProof(dump.replace('private hint','new suggestion'),'com.example.app'),proof);
  assert.notEqual(inputFocusProof(dump.replace('#123','#456'),'com.example.app'),proof);
});
test('IME proof requires the active Workbench editor in the observed application', () => {
  for (const value of ['',dump.replace('mInputStarted=true','mInputStarted=false'),dump.replace('inputType=0x1','inputType=0x0'),dump.replace('RemoteInputConnection{idHash=#123}','null'),dump.replace('org.workbench.ime','org.other.ime')]) {
    assert.equal(inputFocusProof(value,'com.example.app'),undefined);
  }
  assert.equal(inputFocusProof(dump,'com.other.app'),undefined);
});
