# Kimi Code Web 2.7.0 的一个前端 bug 与本地补丁

## 现象

页面加载时报：

```
TypeError: Cannot read properties of undefined (reading 'map')
  at Bet.listSessionGroups (.../index-*.js)
```

同时右上角弹「操作失败 · 刚才的操作没有完成」。

## 原因

Web 前端的 `listSessionGroups()` 请求 `GET /api/v1/sessions?view=by_workspace`，
并假定响应里有 `groups` 数组：

```js
const i = await this.http.get("/sessions", o, n);
return { groups: i.groups.map(...) };
```

但 2.7.0 的服务端把 `groups` 当成会话 id 处理，返回：

```json
{"code":40401,"msg":"session groups does not exist","data":null}
```

于是 `i.groups` 是 `undefined`，`.map` 直接抛错。属于前后端版本内的接口不一致，
与我们导入 session、创建 workspace 都无关（空账号同样能复现）。

## 补丁

对 `dist-web/assets/index-*.js` 做一处替换：没有 `groups` 时用扁平的 `items` 合成一组。

```python
old = "groups:i.groups.map("
new = ("groups:(i.groups??(i.items?[{workspace_id:(i.items[0]||{}).workspace_id,"
       "sessions:i.items.map(Zh),total:i.items.length}]:[])).map(")
```

改完后把文件重命名为 `index-*-p1.js`，并同步替换 `dist-web/index.html` 里的引用，
避免 CDN 缓存旧文件。

## 影响与回滚

- 只影响会话列表的分组展示；分组缺失时退化成「按当前工作区分一组」
- 升级 Kimi Code 后补丁会消失，需要重新应用，或等上游修好
- 回滚：删除 `index-*-p1.js`，把 `index.html` 的引用改回原文件名

## 复现与验证

```bash
curl -H "Authorization: Bearer $TOKEN" https://<host>/api/v1/sessions/groups
# {"code":40401,"msg":"session groups does not exist","data":null}

# 打完补丁后：页面无「操作失败」，侧栏按工作区分组显示会话
```
