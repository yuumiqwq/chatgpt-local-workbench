import { digest } from './store.js';

// Android reports the active IME connection even for inputs absent from the UI tree.
// Keep only its fingerprint; editor hints and input text are not persisted.
export function inputFocusProof(dump: string, packageName: string): string | undefined {
  const service = dump.split(/Input method service state for org\.workbench\.ime\.WorkbenchIme@[^:]+:/).at(1);
  if (!service || !/\bmInputStarted=true\b/.test(service)) return;
  const connection = /\bmStartedInputConnection=(RemoteInputConnection\{[^\r\n}]+\})/.exec(service)?.[1];
  const editor = /mInputEditorInfo:\s*([\s\S]*?)(?=\r?\n  m[A-Z]|$)/.exec(service)?.[1];
  const owner = editor && /\bpackageName=([\w.]+)/.exec(editor)?.[1];
  const inputType = editor && /\binputType=(0x[\da-f]+)/i.exec(editor)?.[1];
  if (!connection || owner !== packageName || !inputType || Number(inputType) === 0) return;
  const field = editor && /\bfieldId=([^\s]+)/.exec(editor)?.[1];
  const autofill = editor && /\bautofillId=([^\s]+)/.exec(editor)?.[1];
  return digest(JSON.stringify([owner, connection, inputType, field, autofill]));
}
