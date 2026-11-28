# 会议知识库:材料看图、大量材料问答、跨会议搜索与问答

日期:2026-11-27。fork 自有功能,不涉及上游。

## 目标

1. 会议材料**看图**:PDF / Word / PowerPoint / Excel 的每一页渲染成图片,模型为每页写视觉笔记(图表数值、
   流程图结构、截图内容)和一句话大纲;扫描版 PDF 由模型直接转写;问答时模型可以翻看原图。
2. **材料很多时**单会议问答仍然准确:放得下就全文,放不下就"目录 + 检索 + 按页阅读 + 看图"。
3. **跨会议搜索与问答**:Dashboard 新页面 Knowledge,在组织内、按看视频的同一套权限检索所有会议的
   字幕、画面、总结章节和材料,回答带可点击出处。

## 已验证的前提(2026-11-27 spike)

- S3 Vectors:`CfnVectorBucket` / `CfnIndex` 在 aws-cdk-lib 里有,但 CfnIndex 还没有 `indexMode`
  和 `textSearchConfigurations`。**向量桶用 CDK 建,索引由应用首次使用时用 SDK 创建**(幂等)。
- 混合检索(2026-11-16 上线):`ENHANCED` 索引,`textSearchConfigurations` 给 `text` 字段配 `zh`
  分析器,查询同时带 `queryVector` 和 `queryTexts`,服务端 BM25 + 向量用 RRF 融合。
- Nova 2 Multimodal Embeddings(`amazon.nova-2-multimodal-embeddings-v1:0`),1024 维,文本和图片同一
  空间。实测:"预约上门时间的选择界面"排第一的是展示该对话框的关键帧图片;`orgId` 过滤生效;
  单次 embedding 约 0.4 s,查询约 0.2 s。
- 限制:topK ≤ 100;单个全文字段 ≤ 100 KB;每向量元数据 ≤ 100 KB(ENHANCED)。

## 一、材料处理管线 v2

上传时仍同步做一次快速文字提取(现有 `extract.ts`),材料立即可用;随后启动
`materialProcessingWorkflow`:

1. **渲染**(复用按需 ECS 任务,`TASK_MODE=render-pages`):Office 文件用 LibreOffice headless 转 PDF,
   PyMuPDF 逐页渲染 1280px JPEG,并按 PDF 页提取文字(Word 因此有了真实页码)。最多 500 页。
   写 `materials/<id>/pages/<n>.jpg` 和 `materials/<id>/pages.v1.json`(页码、图片 key、页文字)。
   HTML / Markdown / 文本不渲染。
2. **视觉笔记**:Sonnet 5.5 每批 6 页(图片 + 该页文字),每页输出 `outline`(一句话)、`visual`
   (图表/表格/截图/流程图的内容,数字原样照抄;纯文字页为空)、`text`(仅当页面没有文字层时转写)。
   最多 300 页。写 `materials/<id>/notes.v1.json`。
3. **合成**:每页内容 = 页文字(或转写)+ 视觉笔记,写回 `text.txt` 和 `pages.v1.json`;清单条目加
   `status`(`processing` / `ready` / `failed`)、`pageCount`、`hasImages`。
4. 触发该会议的知识索引(第二部分)。

扫描版 PDF 不再在上传时拒绝:快速提取为空时状态为 `processing`,由第 2 步转写。
上限调整:每会议 100 份材料、单份 25 MB、总文字 500 万字符(全文放不进上下文时走分层,见下)。

## 二、单会议问答的分层上下文

`MATERIALS_FULL_TEXT_BUDGET`(15 万字符):

- **总量在预算内**:和现在一样,材料全文(含视觉笔记)进缓存上下文。
- **超出预算**:上下文只放**材料目录**——每份材料的名称、页数和逐页一句话大纲(没有大纲时取页首
  80 字)。模型用工具深入:
  - `search_materials(query, material?)`:在本会议材料里混合检索(S3 Vectors,`videoId` + 材料类过滤);
    索引未就绪时退回本地关键词打分。返回最多 8 页的片段和页码。
  - `read_material(material, pages)`:读最多 10 页的完整内容(文字 + 视觉笔记)。
- 两种模式都提供 `look_at_material(material, pages)`:最多 6 页原图。

字幕与画面时间线照旧全量进上下文。

## 三、知识索引(S3 Vectors)

**向量桶** `capstack-knowledge-<hash>`(CDK),**索引** `content-v1`:1024 维 cosine,ENHANCED,
`text` 字段全文检索(zh)。向量 key 稳定可重写:`<videoId>:<kind>:<身份>`。

| kind | 来源 | 切块 | 定位 |
|---|---|---|---|
| `transcript` | `transcription.vtt` | 连续字幕合并到约 800 字 / 90 秒 | start/end 秒 |
| `visual` | `visual.timeline.v1.json` | 每个画面段(描述 + 屏幕文字) | start/end |
| `frame` | `frames.v1.json` 中 keyframe | 图片向量 | t |
| `summary` / `chapter` | AI 总结与章节 | 总结一块,每章一块 | 章节起点 |
| `material` | 材料每页 | 每页,超过 1500 字再切 | 材料 id + 页码 |
| `page` | 材料页图片 | 图片向量 | 材料 id + 页码 |

元数据:可过滤 `orgId` `videoId` `ownerId` `kind` `recordedAt`(秒);不可过滤 `text`(≤ 8 KB,全文检索
字段)、`label`、`title`、`start`、`end`、`materialId`、`materialName`、`page`、`imageKey`。

**增量**:每个会议一份 `<owner>/<video>/knowledge.v1.json`,记录 key → 内容哈希;只 embed 新增或变化的块
(并发 8),PutVectors 每批 ≤ 200,删除清单里已不存在的 key。
**触发**:转写完成、AI 总结完成、画面时间线完成、材料处理完成/删除、视频删除(删全部 key)。
`knowledgeIndexWorkflow` 带 10 分钟锁防重复;锁被占用时写"脏"标记,当前一轮结束后再跑一轮。
**回填**:Knowledge 页面对组织所有者显示"为已有会议建立索引",按会议顺序逐个跑。

## 四、跨会议搜索与问答(`/dashboard/knowledge`)

**权限**:查询时 `orgId` = 当前组织(预过滤),拿 topK 后对出现的每个会议调用 `VideosPolicy.canView`
复核,并排除关闭了字幕的会议;复核不通过的结果丢弃。与看视频的权限一致。

**搜索** `POST /api/knowledge/search`:问题 embedding + 混合检索 topK 50,按会议分组(每会议最多 4 条),
返回片段、类型、时间/页码、缩略图(签名 URL)、跳转链接。

**问答** `POST /api/knowledge/ask`(流式,Opus 5.5,最多 8 步):
- `search_knowledge(query, kinds?)`:同上,返回编号结果;可多次换词检索。
- `read_meeting(videoId, start, end)`:某会议一段时间内的字幕与画面描述。
- `read_material(videoId, materialId, pages)`、`look_at(imageKeys)`:读材料页、看帧/页面原图。
- 回答里的引用写成 `[标签](cap://video/<id>?t=<秒>)` 或 `[标签](cap://material/<videoId>/<materialId>?page=<n>)`,
  前端只渲染检索结果里出现过的 id,其余去掉链接。

**跳转**:分享页支持 `?t=<秒>` 定位、`?tab=materials&material=<id>&page=<n>` 打开材料对应页。
**历史**:每人每组织一份 `knowledge/<orgId>/history/<userId>.v1.json`,最多 60 条。

## 基础设施与权限

- CDK:`CfnVectorBucket`(SSE-S3);任务角色 `s3vectors:CreateIndex/GetIndex/PutVectors/QueryVectors/
  GetVectors/DeleteVectors/ListVectors` 限定该向量桶及其索引;`bedrock:InvokeModel` 已是 `*`。
  向量桶没有公开访问的概念,只能 IAM 访问。
- whisper 镜像:LibreOffice(writer/impress/calc,无 GUI)+ 中文字体 + PyMuPDF,放在模型层之后,
  不让模型层缓存失效。
- 环境变量:`KNOWLEDGE_VECTOR_BUCKET`。

## 费用(量级估计)

embedding 与向量存储:每小时会议加几十页材料约 $0.01 级;视觉笔记每页约 $0.005–0.01;
跨会议问答每次约 $0.05–0.2。

## 测试

纯函数单测:分页提取、切块、key 与哈希、增量计划、分层预算、目录构建、引用链接解析、结果分组与权限过滤。
集成:真实材料(PDF、PPTX、扫描 PDF)渲染 + 笔记;spike 级脚本验证索引与检索;部署后线上验证。
