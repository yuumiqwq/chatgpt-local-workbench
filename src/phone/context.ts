import { digest } from './store.js';

export type PhoneContext = { package: string; window: string; rotation: number; width: number; height: number };
export type DisplayContext = Omit<PhoneContext, 'package'> & { package: string | null; focus: string };
const packagePattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
const unknown = () => new Error('PHONE_DISPLAY_CONTEXT_UNKNOWN');

export function parseDisplayContext(output: string): DisplayContext {
  const headers = [...output.matchAll(/^[ \t]*Display:[ \t]*mDisplayId=(\d+)\b[^\r\n]*/gm)];
  let display = output;
  if (headers.length) {
    const physical = headers.filter(header => header[1] === '0');
    if (physical.length !== 1) throw unknown();
    const index = headers.indexOf(physical[0]!);
    display = output.slice(physical[0]!.index, headers[index + 1]?.index);
  } else if (/^[ \t]*Display:/m.test(output)) throw unknown();
  const focuses = [...display.matchAll(/^[ \t]*mCurrentFocus=(Window\{[^\r\n}]+\}|null)[ \t]*$/gm)];
  if (focuses.length !== 1 || focuses[0]![1] === 'null') throw unknown();
  const focus = focuses[0]![1]!;
  const component = /^Window\{\S+[ \t]+u\d+[ \t]+([A-Za-z][\w.]*)\/[^\s}]+\}$/.exec(focus)?.[1];
  const packageName = component && packagePattern.test(component) ? component : null;
  // Prefer the display's own rotation section over activity override configs.
  const lines = display.split(/\r?\n/), rotationIndex = lines.findIndex(line => line.trim() === 'DisplayRotation');
  let rotationText = display;
  if (rotationIndex >= 0) {
    const indent = lines[rotationIndex]!.search(/\S/);
    let end = rotationIndex + 1;
    while (end < lines.length && (!lines[end]!.trim() || lines[end]!.search(/\S/) > indent)) end++;
    rotationText = lines.slice(rotationIndex + 1, end).join('\n');
  }
  const degrees = /\bmRotation=ROTATION_(0|90|180|270)\b/.exec(rotationText)?.[1];
  const rawRotation = /\b(?:mRotation|rotation)=([0-3])\b/.exec(rotationText)?.[1];
  const size = /Physical size: (\d+)x(\d+)/.exec(output), override = /Override size: (\d+)x(\d+)/.exec(output);
  if ((degrees === undefined && rawRotation === undefined) || !size) throw unknown();
  if (override && (override[1] !== size[1] || override[2] !== size[2])) throw new Error('PHONE_DISPLAY_OVERRIDE_UNSUPPORTED');
  const rotation = degrees === undefined ? Number(rawRotation) : Number(degrees) / 90;
  const width = Number(size[rotation % 2 ? 2 : 1]), height = Number(size[rotation % 2 ? 1 : 2]);
  if (!width || !height || width > 16384 || height > 16384) throw unknown();
  return { package: packageName, window: digest(focus), rotation, width, height, focus };
}

export function parseWindowOwner(output: string, focus: string): string {
  const headers = [...output.matchAll(/^[ \t]*Window #\d+[ \t]+(Window\{[^\r\n}]+\}):[ \t]*$/gm)];
  const selected = headers.filter(header => header[1] === focus);
  if (selected.length !== 1) throw unknown();
  const index = headers.indexOf(selected[0]!);
  const block = output.slice(selected[0]!.index, headers[index + 1]?.index);
  const displays = [...block.matchAll(/^[ \t]*mDisplayId=(\d+)\b/gm)];
  const owners = [...block.matchAll(/^[ \t]*mOwnerUid=\d+\b[^\r\n]*\bpackage=([^\s]+)/gm)];
  if (displays.length !== 1 || displays[0]![1] !== '0' || owners.length !== 1 || !packagePattern.test(owners[0]![1]!)) throw unknown();
  return owners[0]![1]!;
}
