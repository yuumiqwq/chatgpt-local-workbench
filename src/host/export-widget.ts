export const EXPORT_WIDGET_URI = "ui://engineering-bridge/file-export-v1.html";
export const EXPORT_WIDGET_MIME = "text/html;profile=mcp-app";

// Self-contained: binary bytes travel through authenticated MCP calls and the
// ChatGPT host APIs. No third-party scripts, fetches or public file server.
export const EXPORT_WIDGET_HTML = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;font:14px system-ui,sans-serif}body{margin:12px}main{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
#filename{flex-basis:100%;overflow-wrap:anywhere}button,a{font:inherit;padding:10px 16px;border:1px solid currentColor;border-radius:8px;background:transparent;color:inherit;cursor:pointer;text-decoration:none}
button:disabled{opacity:.55;cursor:default}progress{width:100%}[hidden]{display:none!important}
</style></head><body><main>
<span id="filename"></span><button id="prepare" type="button" disabled>准备下载</button>
<button id="pause" type="button" hidden>暂停</button><a id="download" hidden rel="noopener noreferrer" target="_blank">下载</a>
<progress id="progress" value="0" max="1" hidden aria-label="下载进度"></progress>
</main><script>
(() => {
  const el = id => document.getElementById(id);
  const prepare = el('prepare'), pause = el('pause'), download = el('download'), progress = el('progress');
  let meta, parts = [], offset = 0, file, fileId, objectUrl, running = false, generation = 0;
  const host = () => window.openai;
  const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  const timeout = promise => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 30000);
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  const unpack = result => {
    if (result?.isError) throw new Error('tool_error');
    const value = result?.structuredContent || (result?.content
      ? JSON.parse(result.content.find(item => item.type === 'text').text) : result);
    if (!value || value.error) throw new Error('tool_error');
    return value;
  };
  function init(value) {
    if (!value || typeof value.export_id !== 'string' || typeof value.filename !== 'string' ||
        !Number.isSafeInteger(value.size) || value.size < 0 || value.size > 128 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(value.sha256) || value.export_id === meta?.export_id) return;
    generation++;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    meta = value; parts = []; offset = 0; file = undefined; fileId = undefined; objectUrl = undefined;
    const saved = host()?.widgetState?.privateContent;
    if (saved?.export_id === value.export_id && saved?.sha256 === value.sha256 && typeof saved?.file_id === 'string') fileId = saved.file_id;
    el('filename').textContent = value.filename;
    download.hidden = true; download.removeAttribute('href');
    prepare.hidden = false; prepare.disabled = running; prepare.textContent = '准备下载';
    progress.value = 0; progress.max = Math.max(1, value.size); progress.hidden = true;
  }
  function link(href, uploaded) {
    download.href = href; download.download = meta.filename;
    download.textContent = uploaded ? '下载' : '保存到设备';
    download.hidden = false; prepare.hidden = true;
  }
  function localDownload() {
    if (!objectUrl) objectUrl = URL.createObjectURL(file);
    link(objectUrl, false);
  }
  pause.onclick = () => { generation++; pause.disabled = true; };
  prepare.onclick = async () => {
    if (running || !meta) return;
    running = true; prepare.disabled = true; pause.hidden = false; pause.disabled = false;
    const current = ++generation;
    const live = () => { if (current !== generation) throw new Error('paused'); };
    try {
      const api = host();
      if (!file && !fileId) {
        if (!api?.callTool || !crypto?.subtle) throw new Error('unavailable');
        progress.hidden = false;
        while (offset < meta.size) {
          const chunk = unpack(await timeout(api.callTool('read_export_chunk', {
            export_id: meta.export_id, offset, max_bytes: Math.min(meta.chunk_bytes || 65536, 65536)
          })));
          live();
          if (chunk.export_id !== meta.export_id || chunk.offset !== offset || chunk.size !== meta.size ||
              chunk.sha256 !== meta.sha256 || chunk.encoding !== 'base64' || typeof chunk.content !== 'string' ||
              chunk.content.length > 87384) throw new Error('integrity');
          const bytes = Uint8Array.from(atob(chunk.content), char => char.charCodeAt(0));
          if (bytes.length === 0 || bytes.length !== chunk.bytes_read || bytes.length > 65536 ||
              chunk.next_offset !== offset + bytes.length || chunk.next_offset > meta.size ||
              chunk.eof !== (chunk.next_offset === meta.size) || await hash(bytes) !== chunk.chunk_sha256) throw new Error('integrity');
          live();
          parts.push(bytes); offset = chunk.next_offset; progress.value = offset;
        }
        const blob = new Blob(parts, { type: meta.mime_type || 'application/octet-stream' });
        if (blob.size !== meta.size || await hash(await blob.arrayBuffer()) !== meta.sha256) throw new Error('integrity');
        live();
        file = new File([blob], meta.filename, { type: blob.type }); parts = [];
      }
      live();
      if (api?.getFileDownloadUrl && (fileId || api?.uploadFile)) {
        try {
          if (!fileId) {
            const uploaded = await timeout(api.uploadFile(file));
            live();
            if (typeof uploaded?.fileId !== 'string' || !uploaded.fileId) throw new Error('upload');
            fileId = uploaded.fileId;
            api.setWidgetState?.({ privateContent: { export_id: meta.export_id, sha256: meta.sha256, file_id: fileId } });
          }
          const result = await timeout(api.getFileDownloadUrl({ fileId }));
          live();
          const url = new URL(result.downloadUrl);
          if (url.protocol !== 'https:') throw new Error('url');
          link(url.href, true);
        } catch (error) {
          live();
          if (!file) throw error;
          localDownload();
        }
      } else {
        if (!file) throw new Error('unavailable');
        localDownload();
      }
    } catch (error) {
      if (error.message === 'integrity') { parts = []; offset = 0; file = undefined; progress.value = 0; }
      prepare.textContent = error.message === 'paused' ? '继续下载' : '重试下载';
    } finally {
      running = false; prepare.disabled = false; pause.hidden = true;
    }
  };
  window.addEventListener('openai:set_globals', event => init(event.detail?.globals?.toolOutput));
  window.addEventListener('pagehide', () => { generation++; if (objectUrl) URL.revokeObjectURL(objectUrl); });
  init(host()?.toolOutput);
})();
</script></body></html>`;
