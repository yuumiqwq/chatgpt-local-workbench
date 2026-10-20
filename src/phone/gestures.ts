export type TouchAction = { type: string; [key: string]: unknown };
export type NativeScroll = { elementId: string; direction: 'up' | 'down' | 'left' | 'right'; percent: number; speed: number };
export type TouchPlan = { actions: { type: 'pointer'; id: string; parameters: { pointerType: 'touch' }; actions: TouchAction[] }[]; duration_ms: number; points: [number, number][]; scroll?: NativeScroll };
export type TouchBounds = [number, number, number, number];

export function nativeScroll(elementId: string, bounds: TouchBounds, from: [number, number], to: [number, number], duration: number): NativeScroll | undefined {
  const dx = to[0] - from[0], dy = to[1] - from[1], horizontal = Math.abs(dx) > Math.abs(dy);
  const distance = Math.abs(horizontal ? dx : dy), span = horizontal ? bounds[2] - bounds[0] : bounds[3] - bounds[1];
  if (!distance || span <= 0) return;
  // scrollGesture names the content direction, opposite to the finger movement.
  return { elementId, direction: horizontal ? (dx < 0 ? 'right' : 'left') : (dy < 0 ? 'down' : 'up'),
    percent: Math.min(1, distance / span), speed: Math.max(1, Math.round(distance * 1000 / duration)) };
}

export function touchPoint(bounds: TouchBounds, random = Math.random): [number, number] {
  const axis = (lo: number, hi: number) => {
    const center = (lo + hi - 1) / 2;
    const spread = Math.min(6, (hi - lo) * 0.08);
    return Math.max(lo, Math.min(hi - 1, Math.round(center + (random() + random() - 1) * spread)));
  };
  return [axis(bounds[0], bounds[2]), axis(bounds[1], bounds[3])];
}

export function touchGesture(from: [number, number], options: { to?: [number, number]; duration_ms?: number } = {}, random = Math.random): TouchPlan {
  const duration = options.duration_ms ?? Math.round(80 + (random() + random()) * 40);
  if (!Number.isInteger(duration) || duration < 40 || duration > 2000) throw new Error('PHONE_GESTURE_DURATION_INVALID');
  const events: TouchAction[] = [
    { type: 'pointerMove', duration: 0, origin: 'viewport', x: from[0], y: from[1] },
    { type: 'pointerDown', button: 0 }
  ];
  const points: [number, number][] = [from];
  if (options.to) {
    const to = options.to, steps = Math.max(4, Math.min(40, Math.ceil(duration / 20)));
    let elapsed = 0;
    // Ease in and out while retaining the requested endpoints and total time.
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, fraction = t * t * (3 - 2 * t), next = Math.round(duration * t);
      const point: [number, number] = [Math.round(from[0] + (to[0] - from[0]) * fraction), Math.round(from[1] + (to[1] - from[1]) * fraction)];
      events.push({ type: 'pointerMove', duration: next - elapsed, origin: 'viewport', x: point[0], y: point[1] });
      points.push(point); elapsed = next;
    }
  } else events.push({ type: 'pause', duration });
  events.push({ type: 'pointerUp', button: 0 });
  return { actions: [{ type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' }, actions: events }], duration_ms: duration, points };
}
