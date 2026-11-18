# 世界线引擎 · 实现说明

> 这份文档记录 `app/src/world/` 里真正实现的东西、它的数学依据、以及已知边界。
> 写它是为了让评审追问时能指着代码回答，而不是指着 PPT。

## 一句话

**PPT 里讲的 durable band 与 merge3，在产品层是真的在跑** —— 不是示意，不是假数据。
区别在于：状态模型（YunmengLM 的 backbone）在 `云梦-项目/云梦/yunmeng/`，
而这里是把它暴露给创作者的**世界线版本层**，用 TypeScript 独立实现同一套语义。

## 三个文件

| 文件 | 职责 |
|---|---|
| `engine.ts` | 版本树 + 三路合并 + 审计 + 一致性检查 |
| `worldfile.ts` | World File 的导出 / 校验 / 载入 / 往返 |
| `worldline-panel.tsx` | 把上面两样接到界面上 |

## 合并语义（`engine.ts`）

### 三路合并的公式

```ts
t_out = t_a + t_b − t_base      // 逐字段，per uid
```

`base` 取两条世界线的**最近公共祖先（LCA）**。这不是可选项 —— 如果 base 取错，
减法会得到负数。引擎遇到这种情况会**抛错而不是静默算错**：

```ts
if (count < 0 || weightSum < 0) {
  throw new MergeError({ reason: "negative-count", ... });
}
```

### 为什么合并是可交换的

充分统计量 `(count, valueSum, weightSum)` 是**加法**的组合。
加法交换律保证了先合 a 再合 b 与反过来结果一致 —— 测试里逐字节比对状态哈希。

### 标量冲突为什么拒绝而不是择一

标量槽（例如「结局」）不参与数值合并。两侧都改且不同时：

```ts
throw new MergeError({ reason: "scalar-diverged", keys: [...] });
```

**拒绝比静默择一好** —— 静默择一会让创作者以为合并成功了，实际上丢了一条线。

### 幂等性怎么保证

不用计数器去重，而是**显式记录 `mergedFrom`**：

```ts
if (left.mergedFrom.includes(right.id)) return left;
```

这里踩过一个坑：最初用 `isAncestor` 判断，但 `branch` 节点是父状态的副本，
把它当作「已包含」会漏掉真正的合并。测试抓出来了。

### 墓碑永远赢

删除不可逆：

```ts
out.tombstones = { ...a.tombstones, ...b.tombstones, ...base.tombstones };
```

被删掉的记忆不会因为合并而复活。这是防止「回滚 + 合并」把噪声重新带回世界。

## World File（`worldfile.ts`）

### 格式

```json
{
  "magic": "mirai-selene/world",
  "version": 1,
  "meta": { "name": "...", "author": "...", "exportedAt": "..." },
  "tree": { "nodes": {...}, "rootId": "...", "audit": [...], "seq": 12 },
  "checksum": "a1b2c3d4"
}
```

### checksum 覆盖什么

**覆盖状态内容本身，不只是 stateHash 字段。**
最初只哈希结构，结果篡改状态同时保留旧 stateHash 就能绕过校验 —— 测试抓出来了。

### 导出前先校验

```ts
const report = inspectTree(tree);
if (!report.ok) throw new WorldFileError(...);
```

**坏数据不会被导出成坏文件。** 载入同样严格：checksum 不对直接拒绝，不会变成半个世界。

### 往返无损

`roundTrip()` 导出再导入，逐节点比对 `stateHash`。端到端实测：

```
世界完整：20 个节点，4 条世界线，最深 5 层，checksum 一致
```

## 测试覆盖（62 个世界线 / 文件 / 预测测试）

`app/src/world/engine.test.ts`（17 个）

- 三路合并：count 相加、均值正确、交换律、结合律
- 冲突：标量分歧拒绝、单侧改动采用、base 非共同祖先抛错
- 墓碑：一侧删除另一侧无法复活
- 版本树：分叉合并、LCA 求 base、重复合并幂等、树上交换律
- 回滚：状态搬回线末、历史不删、墓碑保留
- 审计：每条动作都有记录且带状态哈希
- 一致性：能发现被篡改的 stateHash

`app/src/world/worldfile.test.ts`（9 个）

- 导出带 magic/version/checksum
- 序列化确定性（同树两次导出字节一致）
- 往返无损
- 导入后可继续操作
- inspect 报告世界规模
- 篡改后 checksum 失配
- 拒绝非世界文件与不支持版本
- 不一致的树拒绝导出

跑：`cd app && npx vitest run src/world`

## 端到端验证

`e2e_v2.py`（在项目根目录）用 WebBridge 驱动真实 Chrome，**20/20 通过**：

观测 → 分叉 → 分支观测 → 三路合并 → 回滚 → 审计 → 校验 → 导出 → 往返载入

截图在 `promo/e2e-1-merged.png`、`e2e-2-audit.png`、`e2e-3-worldfile.png`。

## Stage 侧

`MiraiVN.tsx` 读 `localStorage.mirai.node`，在世界线抽屉里显示：

```
来自 STUDIO 的世界线    n-test
上海线 · 测试
焦虑    均值 5.00 · count 3
房租    均值 4.00 · count 1
1 个墓碑：删掉的记忆不会被合并复活。
```

并且按节点标签自动跳到对应场景（标签含「上海」→ 上海线场景）。

## 诚实的边界

1. **状态模型本身不在这里。** `engine.ts` 实现的是「版本层」的合并语义，
   真正的 `durable band`（RMS 归一化的注意力带）和 `merge3`（Python 版）在
   `云梦-项目/云梦/yunmeng/backbone/routed_scan.py` 与
   `yunmeng/memory/store.py:853`。两边语义一致，但是两套实现，没有共享代码。
2. **Weft 多智能体推演引擎没有实现。** 全盘搜不到代码。产品里推演链路接的是
   MiniMax（`server/mirai-proxy.mjs`），失败时落到本地确定性分支。
3. **没有做真正的持久化后端。** 世界树存在 `localStorage`，导出成文件。
   多端同步、协作编辑都还没做。
4. **冲突检测只到标量粒度。** 数值槽永远能合并（这是充分统计量的性质），
   但如果两条线对同一个角色的「性格」描述完全不同，目前只按字符串不等拒绝，
   没有语义层面的冲突判断。

这四条是**已知边界**，不是待办清单 —— 写在这里是为了被追问时能直接回答。
