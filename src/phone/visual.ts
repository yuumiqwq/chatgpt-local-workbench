import { createHash } from 'node:crypto';

// Persist hashes only, never screenshots or recoverable image thumbnails.
export type VisualSignature = { version: 1; tile_size: number; hashes: string[] };
const TILE_SIZE = 48;

export function visualSignature(rgb: Buffer, width: number, height: number): VisualSignature {
  if (rgb.length !== width * height * 3) throw new Error('PHONE_INVALID_PNG');
  const hashes: string[] = [];
  for (let top = 0; top < height; top += TILE_SIZE) {
    for (let left = 0; left < width; left += TILE_SIZE) {
      const hash = createHash('sha256');
      for (let y = top; y < Math.min(top + TILE_SIZE, height); y++) {
        hash.update(rgb.subarray((y * width + left) * 3, (y * width + Math.min(left + TILE_SIZE, width)) * 3));
      }
      hashes.push(hash.digest('hex'));
    }
  }
  return { version: 1, tile_size: TILE_SIZE, hashes };
}

export function stableTapTarget(expected: VisualSignature | undefined, current: VisualSignature,
  width: number, height: number, x: number, y: number): boolean {
  return stableGestureRegion(expected, current, width, height, x, y, x, y);
}

export function stableSwipeTarget(expected: VisualSignature | undefined, current: VisualSignature,
  width: number, height: number, x: number, y: number, toX: number, toY: number): boolean {
  return stableGestureRegion(expected, current, width, height, x, y, toX, toY);
}

function stableGestureRegion(expected: VisualSignature | undefined, current: VisualSignature,
  width: number, height: number, x: number, y: number, toX: number, toY: number): boolean {
  const columns = Math.ceil(width / TILE_SIZE), rows = Math.ceil(height / TILE_SIZE);
  const valid = (v: VisualSignature | undefined): v is VisualSignature => !!v && v.version === 1 &&
    v.tile_size === TILE_SIZE && Array.isArray(v.hashes) && v.hashes.length === columns * rows &&
    v.hashes.every(h => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h));
  if (!valid(expected) || !valid(current)) return false;
  // Protect the entire gesture and nearby controls, including its destination.
  const radius = Math.max(32, Math.min(96, Math.ceil(Math.min(width, height) / 24)));
  const target = { left: Math.max(0, Math.min(x, toX) - radius), top: Math.max(0, Math.min(y, toY) - radius),
    right: Math.min(width, Math.max(x, toX) + radius + 1), bottom: Math.min(height, Math.max(y, toY) + radius + 1) };
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const index = row * columns + col;
      if (expected.hashes[index] === current.hashes[index]) continue;
      const left = col * TILE_SIZE, top = row * TILE_SIZE;
      const right = Math.min(width, left + TILE_SIZE), bottom = Math.min(height, top + TILE_SIZE);
      if (left < target.right && right > target.left && top < target.bottom && bottom > target.top) return false;
    }
  }
  return true;
}
