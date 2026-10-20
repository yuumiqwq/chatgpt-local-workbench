import type { UiSnapshot } from './ui.js';

export function imageFallbackReason(ui: UiSnapshot, width: number, height: number): string | undefined {
  const named = (ui.nodes ?? []).filter(node => node.text.trim() || node.description.trim());
  const labels = new Set(named.map(node => (node.text.trim() || node.description.trim())));
  if (labels.size < 2 || [...labels].join('').length < 8) return 'sparse_ui';
  // Navigation chrome alone does not describe the contents of a custom page.
  if (!named.some(node => {
    const cy = (node.bounds[1] + node.bounds[3]) / 2;
    return cy > height * 0.15 && cy < height * 0.85;
  })) return 'sparse_content';
  for (const node of ui.nodes ?? []) {
    if (!/(?:Image|ImageView|SurfaceView|TextureView|WebView)$/.test(node.class) && node.class !== 'android.view.View') continue;
    if (node.text.trim() || node.description.trim()) continue;
    const [l,t,r,b] = node.bounds;
    if ((r-l)*(b-t) < width*height*0.15) continue;
    // Labels over a raster image do not describe its contents; a WebView can
    // instead expose the actual page through its accessible descendants.
    if (!/WebView$/.test(node.class) && node.class !== 'android.view.View') return 'unlabelled_visual_region';
    const contents = named.filter(n => n !== node && n.bounds[0] >= l && n.bounds[1] >= t && n.bounds[2] <= r && n.bounds[3] <= b);
    if (contents.length < 2) return 'unlabelled_visual_region';
  }
  return;
}
