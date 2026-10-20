import assert from 'node:assert/strict';
import test from 'node:test';
import { imageFallbackReason } from '../../src/phone/observation.js';
import { uiSnapshot } from '../../src/phone/ui.js';

const label=(text:string,bounds:string)=>`<node package="app" enabled="true" class="android.widget.TextView" text="${text}" bounds="${bounds}"/>`;
const evaluate=(nodes:string)=>imageFallbackReason(uiSnapshot(`<hierarchy>${nodes}</hierarchy>`,'app',1000,2000),1000,2000);
const rich=label('商品名称和规格','[0,500][1000,700]')+label('价格 25.90 元','[0,750][1000,900]');

test('automatic observations keep useful text-only pages and detect incomplete UI',()=>{
  assert.equal(evaluate(rich),undefined);
  assert.equal(evaluate(''),'sparse_ui');
  assert.equal(evaluate(label('返回','[0,0][100,100]')),'sparse_ui');
  assert.equal(evaluate(label('首页和分类导航','[0,0][1000,100]')+label('购物车和我的账号','[0,1900][1000,2000]')),'sparse_content');
  assert.equal(evaluate(rich+'<node package="app" enabled="true" class="android.widget.ImageView" bounds="[0,950][1000,1800]"/>'),'unlabelled_visual_region');
  assert.equal(evaluate(rich+'<node package="app" enabled="true" class="android.widget.Image" bounds="[0,950][1000,1800]"/>'
    +label('1','[100,1000][150,1050]')+label('2','[200,1200][250,1250]')),'unlabelled_visual_region');
  assert.equal(evaluate('<node package="app" enabled="true" class="android.webkit.WebView" bounds="[0,400][1000,1800]">'+rich+'</node>'),undefined);
  assert.equal(evaluate(rich+'<node package="app" enabled="true" class="android.view.View" bounds="[0,950][1000,1800]"/>'),'unlabelled_visual_region');
  assert.equal(evaluate('<node package="app" enabled="true" class="android.view.View" bounds="[0,400][1000,1800]">'+rich+'</node>'),undefined);
});

test('UI-only observations expose selection and focus needed to check the result',()=>{
  const ui=uiSnapshot('<hierarchy><node package="app" enabled="true" text="选择商品" bounds="[0,500][1000,700]" checked="true" selected="false" focused="true"/></hierarchy>','app',1000,2000);
  assert.equal(ui.nodes![0]!.checked,true);
  assert.equal(ui.nodes![0]!.selected,false);
  assert.equal(ui.nodes![0]!.focused,true);
});
