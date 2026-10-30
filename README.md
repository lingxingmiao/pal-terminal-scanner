# 给你配了 · 幻兽帕鲁自动配种工具

Palworld 终端帕鲁识别 + 自动配种树工具，纯浏览器本地运行（ONNX Runtime Web）。

- **配种工具**：<https://lingxingmiao.github.io/pal-terminal-scanner/breeding.html>
- **识别 / 自动打标**：<https://lingxingmiao.github.io/pal-terminal-scanner/>

## 功能

- 上传 / 粘贴 / 拖拽多张终端截图，识别你已有的帕鲁（取并集，可手动增删）。
- 目标输入支持：中文名、全拼、首字母、图鉴编号（`1` / `001` / `5B`）。
- 反查：目标 → 全部父母方案（可按“父母已有”“排除塔主”筛选）。
- 方案树逐层展开：点任意卡片查看它的全部配种方式；已有帕鲁默认当终点不再展开。
- 正查：父母 × 父母 → 子代。
- 推理后端可切换：GPU（WebGPU / WebGL）或 CPU（WASM）。
- 识别页可自动打标并导出中文标注图。

## 模型

- Hugging Face：<https://huggingface.co/Q1ngMang/palworld-terminal-classifier>
  包含 FP32 / FP16 ONNX、`labels.json`、`zh_names.json`、训练与推理脚本。
- 模型：MobileNetV3-Small，输入 96×96，300 类（299 帕鲁 + `__empty__`）。

## 目录

```
docs/            GitHub Pages 站点（识别页 + 配种页 + 模型 + 图标）
LICENSE          AGPL-3.0
```

## 许可与声明

- 本仓库的**代码**（网页、脚本、训练流程）以 **AGPL-3.0** 授权，见 [LICENSE](LICENSE)。
- **模型权重**以 **CC BY-NC 4.0** 授权（署名—非商业性使用 4.0 国际），见 HF 模型卡。
- Palworld 及其帕鲁图标、名称、配种数据等素材 **© Pocketpair, Inc.**，仓库不包含游戏原始资源；
  本工具仅用于粉丝研究与学习，与 Pocketpair 无关联、未获其背书，**禁止商用**。
- 页面、模型与训练代码由 **AI 生成/编写**。
