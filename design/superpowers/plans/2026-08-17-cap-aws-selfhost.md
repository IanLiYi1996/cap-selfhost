# Cap 自建部署到 AWS 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在自有 AWS 账号（us-east-1）上部署一套自建 Cap，同事用 Cognito 登录，视频存私有 S3、经 CloudFront 签名 URL 播放，字幕由自托管 Whisper 生成，AI 摘要走 Bedrock。

**Architecture:** 单个 CDK stack 由按职责拆分的 construct 组成。CloudFront（默认域名）经 VPC origin 连私有 ALB，后面是两个常驻 Fargate 服务（cap-web、media-server）和一个按需 RunTask 的 Whisper 任务。S3 桶 `BLOCK_ALL`，上传走 S3 预签名直传、播放走 CloudFront 签名 URL。应用侧代码改动刻意做薄，新逻辑放新文件以降低上游 merge 冲突。

**Tech Stack:** AWS CDK v2 (TypeScript)、ECS Fargate、Aurora Serverless v2 MySQL 8.0、CloudFront + OAC、Cognito、Bedrock、Python + faster-whisper、NextAuth v4、Vercel Workflow (`"use step"`)、vitest

**Spec:** `design/superpowers/specs/2026-08-17-cap-aws-selfhost-design.md`

## Global Constraints

这些约束适用于**每一个** task，不再逐条重复：

- **仓库与分支**：`IanLiYi1996/cap`，工作分支 `dev`。`main` 是上游纯镜像，**任何情况下不得向 `main` 提交**
- **Region**：`us-east-1`
- **Node 20+ / pnpm 10.5.2 / Rust 1.88.0+**（`CONTRIBUTING.md`）
- **`apps/web/` 下的 Next.js 是改过的版本**。`apps/web/AGENTS.md` 明确要求：动 `apps/web` 的代码前先读 `node_modules/next/dist/docs/`（从 `apps/web/` 解析，monorepo 根目录看不到 `next` 包）。不要凭训练数据里的 Next.js 约定写代码
- **代码风格**（`AGENTS.md`，CI 强制）：TS/JS/JSON/CSS 用 **tab 缩进**、**双引号**。默认不写注释——只在解决完 bug 或复杂问题后，为记录非显然的上下文而写
- **提交后检查**：改了 TS/JS/JSON/CSS/MD → `pnpm exec biome check --write <files>`。改了 Rust → `cargo fmt --all` + `cargo check -p <crate>`
- **禁止编辑生成文件**：`**/tauri.ts`、`apps/desktop/src-tauri/gen/**`、`packages/ui-solid/src/auto-imports.d.ts`、`packages/database/migrations/` 下的 SQL
- **安全基线（不可协商）**：S3 桶必须 `BLOCK_ALL`；任何资源策略不得含 `Principal: "*"`；RDS/Aurora 必须 `publiclyAccessible: false`；SG 不得在非 web 端口开放 `0.0.0.0/0`；不得引入长期 AWS access key
- **`NEXT_PUBLIC_IS_CAP` 必须保持未设置**——这是自建实例解锁 Pro 功能的开关（`packages/utils/src/constants/plans.ts:25`）
- **提交信息**：Conventional style（`feat:` / `fix:` / `chore:` / `refactor:` / `docs:`）
- **首次准备**：本地 clone 尚未 `pnpm install`（Biome 都不可用）。第一个 task 会处理

---

## File Structure

### 新增目录（上游永不冲突，这是刻意的）

```
infra-aws/
  package.json              CDK 依赖与脚本
  tsconfig.json
  cdk.json
  vitest.config.ts
  bin/cap.ts                CDK app 入口
  lib/config.ts             集中的部署参数（region、规格、模型 id）
  lib/cap-stack.ts          组合各 construct，唯一的 Stack
  lib/network.ts            VPC、子网、NAT、S3 Gateway Endpoint
  lib/secrets.ts            CDK 生成的随机密钥
  lib/storage.ts            S3 桶 + Media CloudFront + OAC + key group
  lib/database.ts           Aurora Serverless v2 + DATABASE_URL 拼装
  lib/registry.ts           ECR 仓库
  lib/auth.ts               Cognito user pool + app client
  lib/frontdoor.ts          私有 ALB + listener + App CloudFront（VPC origin）
  lib/compute.ts            ECS cluster、cap-web、media-server（注册到 frontdoor 的 listener）
  lib/whisper.ts            Whisper task definition（RunTask 用，无 service）
  test/security.test.ts     安全基线断言（本项目最有价值的自动化测试）
  test/network.test.ts
  test/storage.test.ts
  test/database.test.ts
  test/compute.test.ts
  scripts/mirror-images.sh  上游镜像 mirror 到 ECR

apps/whisper-server/
  Dockerfile
  pyproject.toml
  src/main.py               S3 读音频 → faster-whisper → S3 写词表 JSON
  src/transcribe.py         纯转写逻辑
  tests/test_transcribe.py

apps/web/lib/whisper.ts     Whisper 词表映射 + RunTask 编排（新文件，让 transcribe.ts 改动尽量薄）
apps/web/__tests__/unit/whisper.test.ts
apps/web/__tests__/unit/cognito-auth.test.ts
```

### 修改现有文件

| 文件 | 改动 | 冲突风险 |
| --- | --- | --- |
| `packages/env/server.ts` | 追加 Cognito ×3、Whisper ×2；`AI_PROVIDER` union 加 `bedrock` | 低 |
| `packages/database/auth/auth-options.ts` | import + providers 数组加 `CognitoProvider` | 低 |
| `apps/web/utils/public-env.tsx` | 类型加 `cognitoAuthAvailable` | 低 |
| `apps/web/app/Layout/AppProviders.tsx` | 传 `cognitoAuthAvailable` | 低 |
| `apps/web/app/(org)/login/form.tsx` | handler + prop + 按钮 + **区块门控条件** | 中 |
| `apps/web/lib/ai/provider.ts` | 五处加 bedrock | 中 |
| `apps/web/workflows/transcribe.ts` | 四处接入 Whisper，保留 AssemblyAI 分支 | **高** |

`transcribe.ts` 冲突风险最高，因此策略是：**不删除任何 AssemblyAI 代码**，只加 `if` 分支，且所有新逻辑放在 `apps/web/lib/whisper.ts`，让这个文件里的 diff 尽量小。

### construct 构造顺序（有依赖环，顺序不能随意改）

桶的 CORS 需要 App CloudFront 域名 → App CF 需要 ALB → cap-web 的环境变量需要桶名。若把 ALB 放在 `compute.ts` 里就成环了。解法是**把 ALB 拆到 `frontdoor.ts`**，`compute.ts` 只把服务注册到 frontdoor 暴露的 listener 上。

`cap-stack.ts` 里的构造顺序必须是：

```
Network → FrontDoor(ALB + App CF) → Storage(桶 CORS ← appDomain, Media CF)
        → Secrets → Database → Registry → Auth(Cognito 回调 ← appDomain)
        → Compute(服务，注册到 frontdoor.listener) → Whisper(task definition)
```

### 跨阶段依赖（用户要求单份计划，这些是需要复核的接缝）

单份计划意味着后段 task 建立在前段尚未实跑验证的假设上。以下三处最可能需要回头修，实施到对应 task 时**先复核再动手**：

1. **Task 9 → Task 3**：CloudFront VPC origin 若不支持我们的 ALB 配置，Task 9 会失败，需回退到 internet-facing ALB + 前缀列表 SG（spec §5 退路）
2. **Task 18 → Task 16/17**：`transcribe.ts` 的实际接入点若与本计划记录的行号漂移（上游活跃文件），以 `grep -n "ASSEMBLY_API_KEY\|transcribeWithAssemblyAI"` 重新定位为准
3. **Task 20 → Task 11**：Bedrock 模型 id 需在 Task 20 前确认账号已开通模型访问，否则单测能过、实跑 403

---

## Task 1: CDK app 骨架与安全基线测试

先建立测试骨架而不是先写基础设施——安全断言是本项目最重要的自动化保障（Global Constraints 里那条"不可协商"的基线），它必须从第一个 task 就存在，后续每加一个资源都自动被检查。

**Files:**
- Create: `infra-aws/package.json`
- Create: `infra-aws/tsconfig.json`
- Create: `infra-aws/cdk.json`
- Create: `infra-aws/vitest.config.ts`
- Create: `infra-aws/lib/config.ts`
- Create: `infra-aws/lib/cap-stack.ts`
- Create: `infra-aws/bin/cap.ts`
- Test: `infra-aws/test/security.test.ts`

**Interfaces:**
- Consumes: 无（首个 task）
- Produces:
  - `CONFIG` from `lib/config.ts`：`{ region: string; appName: string; whisperModel: string; bedrockGenerationModel: string; bedrockChatModel: string }`
  - `class CapStack extends cdk.Stack`，构造签名 `(scope: Construct, id: string, props?: cdk.StackProps)`
  - `synthCapStack(): Template` from `test/security.test.ts` 之外的复用点——本 task 将其放在 `test/security.test.ts` 内，Task 2 起改为从各自测试文件独立 synth（避免测试间共享状态）

- [ ] **Step 1: 安装依赖并确认工具链可用**

本地 clone 尚未 `pnpm install`，Biome 不可用。先修好。

```bash
cd /home/ec2-user/research/cap
git checkout dev
pnpm install
pnpm exec biome --version
```

Expected: 打印 Biome 版本号（若失败，后续所有格式检查步骤都会失败）

- [ ] **Step 2: 创建 CDK 工程文件**

`infra-aws/package.json`：

```json
{
	"name": "@cap/infra-aws",
	"private": true,
	"version": "0.0.0",
	"bin": { "cap-infra": "bin/cap.js" },
	"scripts": {
		"build": "tsc",
		"synth": "cdk synth",
		"deploy": "cdk deploy",
		"diff": "cdk diff",
		"test": "vitest run"
	},
	"devDependencies": {
		"@types/node": "^20.11.0",
		"aws-cdk": "^2.180.0",
		"typescript": "^5.8.3",
		"vitest": "~2.1.9"
	},
	"dependencies": {
		"aws-cdk-lib": "^2.180.0",
		"constructs": "^10.4.2"
	}
}
```

`infra-aws/tsconfig.json`：

```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "NodeNext",
		"moduleResolution": "NodeNext",
		"lib": ["ES2022"],
		"strict": true,
		"noEmit": true,
		"esModuleInterop": true,
		"skipLibCheck": true,
		"types": ["node"]
	},
	"include": ["bin/**/*.ts", "lib/**/*.ts", "test/**/*.ts"]
}
```

`infra-aws/cdk.json`：

```json
{
	"app": "npx tsx bin/cap.ts",
	"context": {
		"@aws-cdk/aws-iam:minimizePolicies": true,
		"@aws-cdk/core:checkSecretUsage": true
	}
}
```

`infra-aws/vitest.config.ts`：

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		testTimeout: 60000,
	},
});
```

- [ ] **Step 3: 写集中配置与空 stack**

`infra-aws/lib/config.ts`：

```typescript
export const CONFIG = {
	region: "us-east-1",
	appName: "cap",
	whisperModel: "medium",
	bedrockGenerationModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
	bedrockChatModel: "us.anthropic.claude-sonnet-5-20250929-v1:0",
} as const;
```

> Bedrock 模型 id 需在 Task 20 之前用 `aws bedrock list-foundation-models --region us-east-1` 核实并确认账号已开通访问（见「跨阶段依赖」第 3 条）。

`infra-aws/lib/cap-stack.ts`：

```typescript
import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";

export class CapStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props?: cdk.StackProps) {
		super(scope, id, props);
	}
}
```

`infra-aws/bin/cap.ts`：

```typescript
import * as cdk from "aws-cdk-lib";
import { CapStack } from "../lib/cap-stack.js";
import { CONFIG } from "../lib/config.js";

const app = new cdk.App();

new CapStack(app, "CapStack", {
	env: {
		account: process.env.CDK_DEFAULT_ACCOUNT,
		region: CONFIG.region,
	},
});
```

- [ ] **Step 4: 写安全基线断言测试**

这五条对应 Global Constraints 的安全基线。空 stack 也应当通过（没有资源就没有违规），随着资源加入它们才真正发挥作用。

`infra-aws/test/security.test.ts`：

```typescript
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { CapStack } from "../lib/cap-stack.js";
import { CONFIG } from "../lib/config.js";

let template: Template;

beforeAll(() => {
	const app = new cdk.App();
	const stack = new CapStack(app, "TestStack", {
		env: { account: "123456789012", region: CONFIG.region },
	});
	template = Template.fromStack(stack);
});

const resourcesOfType = (type: string) =>
	Object.values(template.findResources(type));

describe("安全基线", () => {
	it("每个 S3 桶都完全阻断公开访问", () => {
		for (const bucket of resourcesOfType("AWS::S3::Bucket")) {
			expect(bucket.Properties?.PublicAccessBlockConfiguration).toEqual({
				BlockPublicAcls: true,
				BlockPublicPolicy: true,
				IgnorePublicAcls: true,
				RestrictPublicBuckets: true,
			});
		}
	});

	it("没有任何资源策略把 Principal 设为通配 *", () => {
		const policyTypes = [
			"AWS::S3::BucketPolicy",
			"AWS::SQS::QueuePolicy",
			"AWS::SNS::TopicPolicy",
			"AWS::IAM::Role",
		];
		for (const type of policyTypes) {
			for (const resource of resourcesOfType(type)) {
				const json = JSON.stringify(resource.Properties ?? {});
				expect(json).not.toContain('"Principal":"*"');
				expect(json).not.toContain('"Principal":{"AWS":"*"}');
			}
		}
	});

	it("数据库集群不可公网访问", () => {
		for (const instance of resourcesOfType("AWS::RDS::DBInstance")) {
			expect(instance.Properties?.PubliclyAccessible).not.toBe(true);
		}
	});

	it("没有 SG 规则在非 web 端口向 0.0.0.0/0 开放", () => {
		const WEB_PORTS = new Set([80, 443]);
		const ingressRules = [
			...resourcesOfType("AWS::EC2::SecurityGroupIngress"),
			...resourcesOfType("AWS::EC2::SecurityGroup").flatMap(
				(sg) => (sg.Properties?.SecurityGroupIngress as unknown[]) ?? [],
			),
		] as Array<Record<string, unknown>>;

		for (const rule of ingressRules) {
			const props = (rule.Properties ?? rule) as Record<string, unknown>;
			if (props.CidrIp !== "0.0.0.0/0") continue;
			expect(WEB_PORTS.has(Number(props.FromPort))).toBe(true);
			expect(WEB_PORTS.has(Number(props.ToPort))).toBe(true);
		}
	});

	it("task definition 里不出现明文 AWS 凭据", () => {
		for (const taskDef of resourcesOfType("AWS::ECS::TaskDefinition")) {
			const json = JSON.stringify(taskDef.Properties ?? {});
			expect(json).not.toContain("CAP_AWS_ACCESS_KEY");
			expect(json).not.toContain("CAP_AWS_SECRET_KEY");
		}
	});
});
```

- [ ] **Step 5: 安装依赖并运行测试**

```bash
cd infra-aws
pnpm install
pnpm add -D tsx
pnpm test
```

Expected: 5 个测试全部 PASS（空 stack 无资源，所有循环体为空）

- [ ] **Step 6: 确认 synth 可用**

```bash
cd infra-aws && pnpm synth
```

Expected: 输出 CloudFormation YAML，无报错。若报缺少 account，设 `CDK_DEFAULT_ACCOUNT` 或先 `aws sts get-caller-identity` 确认凭据可用

- [ ] **Step 7: 格式化并提交**

```bash
cd /home/ec2-user/research/cap
pnpm exec biome check --write infra-aws
git add infra-aws
git commit -m "feat(infra-aws): scaffold CDK app with security baseline assertions"
```

---

## Task 2: 网络（VPC、子网、NAT、S3 Gateway Endpoint）

**Files:**
- Create: `infra-aws/lib/network.ts`
- Modify: `infra-aws/lib/cap-stack.ts`
- Test: `infra-aws/test/network.test.ts`

**Interfaces:**
- Consumes: `CapStack`、`CONFIG`（Task 1）
- Produces: `class Network extends Construct`，暴露 `readonly vpc: ec2.Vpc`。Task 5（Aurora）、Task 7（ECS/ALB）、Task 19（Whisper task）都通过 `network.vpc` 取用

- [ ] **Step 1: 写失败测试**

`infra-aws/test/network.test.ts`：

```typescript
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { CapStack } from "../lib/cap-stack.js";
import { CONFIG } from "../lib/config.js";

let template: Template;

beforeAll(() => {
	const app = new cdk.App();
	const stack = new CapStack(app, "TestStack", {
		env: { account: "123456789012", region: CONFIG.region },
	});
	template = Template.fromStack(stack);
});

describe("Network", () => {
	it("建一个双 AZ 的 VPC", () => {
		template.resourceCountIs("AWS::EC2::VPC", 1);
		// 2 AZ × (public + private) = 4 个子网
		template.resourceCountIs("AWS::EC2::Subnet", 4);
	});

	it("只用一个 NAT Gateway（AZ 冗余不值这个成本）", () => {
		template.resourceCountIs("AWS::EC2::NatGateway", 1);
	});

	it("有 S3 Gateway Endpoint，让视频字节不走 NAT", () => {
		template.hasResourceProperties("AWS::EC2::VPCEndpoint", {
			VpcEndpointType: "Gateway",
		});
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd infra-aws && pnpm test test/network.test.ts`
Expected: FAIL —「Expected 1 resources of type AWS::EC2::VPC but found 0」

- [ ] **Step 3: 实现 Network construct**

`infra-aws/lib/network.ts`：

```typescript
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";

export class Network extends Construct {
	readonly vpc: ec2.Vpc;

	constructor(scope: Construct, id: string) {
		super(scope, id);

		this.vpc = new ec2.Vpc(this, "Vpc", {
			ipAddresses: ec2.IpAddresses.cidr("10.0.0.0/16"),
			maxAzs: 2,
			natGateways: 1,
			subnetConfiguration: [
				{
					name: "public",
					subnetType: ec2.SubnetType.PUBLIC,
					cidrMask: 24,
				},
				{
					name: "private",
					subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
					cidrMask: 20,
				},
			],
		});

		this.vpc.addGatewayEndpoint("S3Endpoint", {
			service: ec2.GatewayVpcEndpointAwsService.S3,
		});
	}
}
```

- [ ] **Step 4: 接入 stack**

`infra-aws/lib/cap-stack.ts` 改为：

```typescript
import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import { Network } from "./network.js";

export class CapStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props?: cdk.StackProps) {
		super(scope, id, props);

		new Network(this, "Network");
	}
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd infra-aws && pnpm test`
Expected: network 的 3 个测试 PASS，security 的 5 个仍然 PASS（NAT 所在的公有子网路由不产生非 web 端口的 0.0.0.0/0 入站规则）

- [ ] **Step 6: 格式化并提交**

```bash
cd /home/ec2-user/research/cap
pnpm exec biome check --write infra-aws
git add infra-aws
git commit -m "feat(infra-aws): add VPC with single NAT and S3 gateway endpoint"
```

---

## Task 3: FrontDoor（私有 ALB + App CloudFront VPC origin）

这个 task 最先暴露整套设计里风险最高的一环（见「跨阶段依赖」第 1 条）。如果 `VpcOrigin` L2 在当前 CDK 版本不可用或不支持我们的 ALB 配置，**立即停下改走退路**：internet-facing ALB + SG 只放行 `com.amazonaws.global.cloudfront.origin-facing` 前缀列表 + 校验 CloudFront 注入的自定义 header。不要在这里硬耗。

**Files:**
- Create: `infra-aws/lib/frontdoor.ts`
- Modify: `infra-aws/lib/cap-stack.ts`
- Test: `infra-aws/test/frontdoor.test.ts`

**Interfaces:**
- Consumes: `Network`（Task 2）的 `vpc`
- Produces: `class FrontDoor extends Construct`，暴露：
  - `readonly alb: elbv2.ApplicationLoadBalancer`
  - `readonly listener: elbv2.ApplicationListener`（Task 7 用来注册 cap-web 目标组）
  - `readonly distribution: cloudfront.Distribution`
  - `readonly appUrl: string`（`https://<domain>`，Task 4 的 CORS、Task 9 的 Cognito 回调、Task 7 的 `WEB_URL` 都用它）

- [ ] **Step 1: 写失败测试**

`infra-aws/test/frontdoor.test.ts`：

```typescript
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { CapStack } from "../lib/cap-stack.js";
import { CONFIG } from "../lib/config.js";

let template: Template;

beforeAll(() => {
	const app = new cdk.App();
	const stack = new CapStack(app, "TestStack", {
		env: { account: "123456789012", region: CONFIG.region },
	});
	template = Template.fromStack(stack);
});

describe("FrontDoor", () => {
	it("ALB 是 internal，不是 internet-facing", () => {
		template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
			Scheme: "internal",
		});
	});

	it("建了 CloudFront VPC origin 而非公网 origin", () => {
		template.resourceCountIs("AWS::CloudFront::VpcOrigin", 1);
	});

	it("CloudFront 强制 HTTPS 并允许所有方法（上传/表单需要 POST）", () => {
		template.hasResourceProperties("AWS::CloudFront::Distribution", {
			DistributionConfig: {
				DefaultCacheBehavior: {
					ViewerProtocolPolicy: "redirect-to-https",
				},
			},
		});
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd infra-aws && pnpm test test/frontdoor.test.ts`
Expected: FAIL —「Expected 1 resources of type AWS::CloudFront::VpcOrigin but found 0」

- [ ] **Step 3: 实现 FrontDoor construct**

`infra-aws/lib/frontdoor.ts`：

```typescript
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Construct } from "constructs";

export interface FrontDoorProps {
	readonly vpc: ec2.Vpc;
}

export class FrontDoor extends Construct {
	readonly alb: elbv2.ApplicationLoadBalancer;
	readonly listener: elbv2.ApplicationListener;
	readonly distribution: cloudfront.Distribution;

	constructor(scope: Construct, id: string, props: FrontDoorProps) {
		super(scope, id);

		const albSecurityGroup = new ec2.SecurityGroup(this, "AlbSg", {
			vpc: props.vpc,
			description: "Internal ALB fronted by CloudFront VPC origin",
			allowAllOutbound: true,
		});

		// The CloudFront VPC origin terminates on an ENI inside this VPC, so the
		// ALB only ever sees VPC-internal source addresses. Scoped to the VPC
		// CIDR rather than 0.0.0.0/0 to keep the security baseline assertions
		// meaningful.
		albSecurityGroup.addIngressRule(
			ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
			ec2.Port.tcp(80),
			"CloudFront VPC origin",
		);

		this.alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
			vpc: props.vpc,
			internetFacing: false,
			securityGroup: albSecurityGroup,
			vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
			// 与 packages/database/auth/auth-options.ts:20 的 maxDuration = 120
			// 对齐，登录流程需要这么长
			idleTimeout: cdk.Duration.seconds(120),
		});

		this.listener = this.alb.addListener("Http", {
			port: 80,
			protocol: elbv2.ApplicationProtocol.HTTP,
			defaultAction: elbv2.ListenerAction.fixedResponse(503, {
				contentType: "text/plain",
				messageBody: "No target registered",
			}),
		});

		this.distribution = new cloudfront.Distribution(this, "App", {
			defaultBehavior: {
				origin: origins.VpcOrigin.withApplicationLoadBalancer(this.alb, {
					protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
					// 60 秒是 CloudFront 对 origin 读超时的上限
					readTimeout: cdk.Duration.seconds(60),
				}),
				viewerProtocolPolicy:
					cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
				allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
				cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
				originRequestPolicy:
					cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
			},
		});
	}

	get appUrl(): string {
		return `https://${this.distribution.distributionDomainName}`;
	}
}
```

文件顶部需要 `import * as cdk from "aws-cdk-lib";`（上面的 `cdk.Duration` 用到）。

缓存策略选 `CACHING_DISABLED` + `ALL_VIEWER_EXCEPT_HOST_HEADER`：Next.js 应用自己带缓存头，CloudFront 层再缓存会让登录态和 dashboard 出错；`EXCEPT_HOST_HEADER` 是 ALB origin 的必需项（转发原始 Host 会让 ALB 路由失败）。

- [ ] **Step 4: 接入 stack**

`infra-aws/lib/cap-stack.ts`：

```typescript
import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import { FrontDoor } from "./frontdoor.js";
import { Network } from "./network.js";

export class CapStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props?: cdk.StackProps) {
		super(scope, id, props);

		const network = new Network(this, "Network");
		const frontDoor = new FrontDoor(this, "FrontDoor", {
			vpc: network.vpc,
		});

		new cdk.CfnOutput(this, "AppUrl", { value: frontDoor.appUrl });
	}
}
```

- [ ] **Step 5: 运行全部测试**

Run: `cd infra-aws && pnpm test`
Expected: frontdoor 3 个 PASS，network 3 个 PASS，security 5 个 PASS。**security 里的 SG 断言此时才真正生效**——若把 ingress 写成了 `0.0.0.0/0` 且端口非 80/443 就会红

- [ ] **Step 6: 格式化并提交**

```bash
cd /home/ec2-user/research/cap
pnpm exec biome check --write infra-aws
git add infra-aws
git commit -m "feat(infra-aws): add internal ALB behind CloudFront VPC origin"
```

---

## Task 4: 存储（私有 S3 + Media CloudFront 签名 URL）

**Files:**
- Create: `infra-aws/lib/storage.ts`
- Modify: `infra-aws/lib/cap-stack.ts`
- Test: `infra-aws/test/storage.test.ts`

**Interfaces:**
- Consumes: `FrontDoor.appUrl`（Task 3）
- Produces: `class Storage extends Construct`，暴露：
  - `readonly bucket: s3.Bucket`（Task 7 用于 `CAP_AWS_BUCKET` 与 Task Role 授权，Task 18 用于 Whisper 任务读写）
  - `readonly distribution: cloudfront.Distribution`
  - `readonly bucketUrl: string`（`CAP_AWS_BUCKET_URL`）
  - `readonly keyPairId: string`（`CLOUDFRONT_KEYPAIR_ID`）

- [ ] **Step 1: 生成 CloudFront 签名密钥对**

私钥无法由 CDK 生成——它必须与公钥配对且要能被应用读到。先手工生成，公钥进 CDK、私钥进 Secrets Manager（Task 5 建 secret，此处先产出文件）。

```bash
mkdir -p /home/ec2-user/.claude/jobs/030daad0/tmp/cf-keys
cd /home/ec2-user/.claude/jobs/030daad0/tmp/cf-keys
openssl genrsa -out private_key.pem 2048
openssl rsa -pubout -in private_key.pem -out public_key.pem
cat public_key.pem
```

Expected: 输出 `-----BEGIN PUBLIC KEY-----` 开头的 PEM

**这两个文件不要提交进仓库。** 私钥在 Task 5 之后手工放进 Secrets Manager 即可删除本地副本。

- [ ] **Step 2: 写失败测试**

`infra-aws/test/storage.test.ts`：

```typescript
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { CapStack } from "../lib/cap-stack.js";
import { CONFIG } from "../lib/config.js";

let template: Template;

beforeAll(() => {
	process.env.CAP_CLOUDFRONT_PUBLIC_KEY = [
		"-----BEGIN PUBLIC KEY-----",
		"MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtest",
		"-----END PUBLIC KEY-----",
	].join("\n");

	const app = new cdk.App();
	const stack = new CapStack(app, "TestStack", {
		env: { account: "123456789012", region: CONFIG.region },
	});
	template = Template.fromStack(stack);
});

describe("Storage", () => {
	it("桶阻断一切公开访问且强制 TLS", () => {
		template.hasResourceProperties("AWS::S3::Bucket", {
			PublicAccessBlockConfiguration: {
				BlockPublicAcls: true,
				BlockPublicPolicy: true,
				IgnorePublicAcls: true,
				RestrictPublicBuckets: true,
			},
		});
	});

	it("桶策略只授权 CloudFront service principal，并带 SourceArn 条件", () => {
		const policies = Object.values(
			template.findResources("AWS::S3::BucketPolicy"),
		);
		expect(policies.length).toBeGreaterThan(0);

		const json = JSON.stringify(policies);
		expect(json).toContain("cloudfront.amazonaws.com");
		expect(json).toContain("AWS:SourceArn");
		expect(json).not.toContain('"Principal":"*"');
	});

	it("Media distribution 用 trusted key group 强制签名 URL", () => {
		template.resourceCountIs("AWS::CloudFront::KeyGroup", 1);
		template.hasResourceProperties("AWS::CloudFront::Distribution", {
			DistributionConfig: {
				DefaultCacheBehavior: {
					TrustedKeyGroups: Match.anyValue(),
				},
			},
		});
	});

	it("桶 CORS 只允许 App distribution 域名，不是通配", () => {
		const buckets = Object.values(template.findResources("AWS::S3::Bucket"));
		const cors = buckets[0]?.Properties?.CorsConfiguration;
		expect(cors).toBeDefined();
		expect(JSON.stringify(cors)).not.toContain('"*"');
	});
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd infra-aws && pnpm test test/storage.test.ts`
Expected: FAIL — 找不到 `AWS::S3::Bucket`

- [ ] **Step 4: 实现 Storage construct**

`infra-aws/lib/storage.ts`：

```typescript
import * as cdk from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface StorageProps {
	/** App CloudFront 的 https URL，用于桶 CORS 白名单 */
	readonly appUrl: string;
}

function requireSigningPublicKey(): string {
	const key = process.env.CAP_CLOUDFRONT_PUBLIC_KEY;
	if (!key) {
		throw new Error(
			"CAP_CLOUDFRONT_PUBLIC_KEY is not set. Generate a keypair with " +
				"`openssl genrsa -out private_key.pem 2048` and " +
				"`openssl rsa -pubout -in private_key.pem -out public_key.pem`, " +
				"then export the public key PEM.",
		);
	}
	return key;
}

export class Storage extends Construct {
	readonly bucket: s3.Bucket;
	readonly distribution: cloudfront.Distribution;
	readonly keyPairId: string;

	constructor(scope: Construct, id: string, props: StorageProps) {
		super(scope, id);

		this.bucket = new s3.Bucket(this, "Recordings", {
			blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
			encryption: s3.BucketEncryption.S3_MANAGED,
			enforceSSL: true,
			removalPolicy: cdk.RemovalPolicy.RETAIN,
			cors: [
				{
					allowedOrigins: [props.appUrl],
					allowedMethods: [
						s3.HttpMethods.GET,
						s3.HttpMethods.POST,
						s3.HttpMethods.PUT,
					],
					allowedHeaders: ["*"],
					maxAge: 3000,
				},
			],
		});

		const publicKey = new cloudfront.PublicKey(this, "SigningPublicKey", {
			encodedKey: requireSigningPublicKey(),
		});

		const keyGroup = new cloudfront.KeyGroup(this, "SigningKeyGroup", {
			items: [publicKey],
		});

		this.keyPairId = publicKey.publicKeyId;

		this.distribution = new cloudfront.Distribution(this, "Media", {
			defaultBehavior: {
				origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
				viewerProtocolPolicy:
					cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
				allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
				cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
				trustedKeyGroups: [keyGroup],
			},
		});
	}

	get bucketUrl(): string {
		return `https://${this.distribution.distributionDomainName}`;
	}
}
```

`S3BucketOrigin.withOriginAccessControl()` 会自动建 OAC 并写入带 `AWS:SourceArn` 条件的桶策略——这正是 Step 2 第二个测试要断言的，不要手写桶策略。

- [ ] **Step 5: 接入 stack**

在 `cap-stack.ts` 的 `frontDoor` 之后加：

```typescript
		const storage = new Storage(this, "Storage", {
			appUrl: frontDoor.appUrl,
		});

		new cdk.CfnOutput(this, "BucketName", { value: storage.bucket.bucketName });
		new cdk.CfnOutput(this, "BucketUrl", { value: storage.bucketUrl });
		new cdk.CfnOutput(this, "CloudFrontKeyPairId", {
			value: storage.keyPairId,
		});
```

并在顶部加 `import { Storage } from "./storage.js";`

- [ ] **Step 6: 运行全部测试**

```bash
cd infra-aws
export CAP_CLOUDFRONT_PUBLIC_KEY="$(cat /home/ec2-user/.claude/jobs/030daad0/tmp/cf-keys/public_key.pem)"
pnpm test
```

Expected: storage 4 个 PASS，之前 11 个仍 PASS。**security 的桶断言与 Principal 断言此时开始真正保护基线**

- [ ] **Step 7: 格式化并提交**

```bash
cd /home/ec2-user/research/cap
pnpm exec biome check --write infra-aws
git add infra-aws
git commit -m "feat(infra-aws): add private S3 bucket with CloudFront signed-URL delivery"
```

---

## Task 5: 密钥与数据库（Aurora Serverless v2）

**Files:**
- Create: `infra-aws/lib/secrets.ts`
- Create: `infra-aws/lib/database.ts`
- Modify: `infra-aws/lib/cap-stack.ts`
- Test: `infra-aws/test/database.test.ts`

**Interfaces:**
- Consumes: `Network.vpc`
- Produces:
  - `class AppSecrets extends Construct`，暴露 `nextAuthSecret`、`databaseEncryptionKey`、`mediaServerWebhookSecret`、`cloudFrontPrivateKey`、`databaseUrl`，全部为 `secretsmanager.Secret`
  - `class Database extends Construct`，暴露 `readonly cluster: rds.DatabaseCluster`、`readonly securityGroup: ec2.SecurityGroup`

**关于 `DATABASE_URL` 的一个刻意决定**：不在 CDK 里把生成的密码拼进 URL 字符串。任何走 CloudFormation 动态引用的拼装都会把明文密码落进 ECS task definition（`describe-task-definition` 就能看到），这违反 Global Constraints。因此 `databaseUrl` 建成一个**空壳 secret**，部署后用一条 CLI 命令填入。这与 CloudFront 私钥是同一个模式——两处手工步骤，换来零明文。

- [ ] **Step 1: 写失败测试**

`infra-aws/test/database.test.ts`：

```typescript
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { CapStack } from "../lib/cap-stack.js";
import { CONFIG } from "../lib/config.js";

let template: Template;

beforeAll(() => {
	process.env.CAP_CLOUDFRONT_PUBLIC_KEY = [
		"-----BEGIN PUBLIC KEY-----",
		"MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtest",
		"-----END PUBLIC KEY-----",
	].join("\n");

	const app = new cdk.App();
	const stack = new CapStack(app, "TestStack", {
		env: { account: "123456789012", region: CONFIG.region },
	});
	template = Template.fromStack(stack);
});

describe("Database", () => {
	it("是 Aurora MySQL Serverless v2，容量 0.5 到 4 ACU", () => {
		template.hasResourceProperties("AWS::RDS::DBCluster", {
			Engine: "aurora-mysql",
			ServerlessV2ScalingConfiguration: {
				MinCapacity: 0.5,
				MaxCapacity: 4,
			},
		});
	});

	it("集群实例不可公网访问", () => {
		const instances = Object.values(
			template.findResources("AWS::RDS::DBInstance"),
		);
		expect(instances.length).toBeGreaterThan(0);
		for (const instance of instances) {
			expect(instance.Properties?.PubliclyAccessible).not.toBe(true);
		}
	});

	it("强制 TLS 连接", () => {
		template.hasResourceProperties("AWS::RDS::DBClusterParameterGroup", {
			Parameters: { require_secure_transport: "ON" },
		});
	});

	it("存储加密且保留 7 天备份", () => {
		template.hasResourceProperties("AWS::RDS::DBCluster", {
			StorageEncrypted: true,
			BackupRetentionPeriod: 7,
		});
	});

	it("建了应用需要的五个 secret", () => {
		template.resourceCountIs("AWS::SecretsManager::Secret", 6);
	});
});
```

> 断言 6 个 secret：五个应用 secret + Aurora 自动生成的凭据 secret。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd infra-aws && pnpm test test/database.test.ts`
Expected: FAIL — 找不到 `AWS::RDS::DBCluster`

- [ ] **Step 3: 实现 AppSecrets**

`infra-aws/lib/secrets.ts`：

```typescript
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

/** 32 字节 hex，CDK 生成后我们从不读取明文 */
function hexSecret(scope: Construct, id: string): secretsmanager.Secret {
	return new secretsmanager.Secret(scope, id, {
		generateSecretString: {
			passwordLength: 64,
			excludePunctuation: true,
			excludeUppercase: true,
			excludeCharacters: "ghijklmnopqrstuvwxyz",
		},
	});
}

export class AppSecrets extends Construct {
	readonly nextAuthSecret: secretsmanager.Secret;
	readonly databaseEncryptionKey: secretsmanager.Secret;
	readonly mediaServerWebhookSecret: secretsmanager.Secret;
	readonly cloudFrontPrivateKey: secretsmanager.Secret;
	readonly databaseUrl: secretsmanager.Secret;

	constructor(scope: Construct, id: string) {
		super(scope, id);

		this.nextAuthSecret = hexSecret(this, "NextAuthSecret");
		// 一旦有数据就不能再改：用户自定义 S3 凭据是用它加密存库的
		// (apps/web/app/api/desktop/[...route]/s3Config.ts)
		this.databaseEncryptionKey = hexSecret(this, "DatabaseEncryptionKey");
		this.mediaServerWebhookSecret = hexSecret(this, "MediaServerWebhookSecret");

		// 这两个必须部署后手工填入：私钥要与 CDK 里的公钥配对，
		// DATABASE_URL 若在 CDK 里拼装会把明文密码落进 task definition。
		this.cloudFrontPrivateKey = new secretsmanager.Secret(
			this,
			"CloudFrontPrivateKey",
			{ description: "PEM private key paired with the CloudFront public key" },
		);
		this.databaseUrl = new secretsmanager.Secret(this, "DatabaseUrl", {
			description: "Full mysql:// URL including ?ssl={...}",
		});
	}
}
```

`excludeCharacters` 加上 `excludeUppercase` 与 `excludePunctuation` 后，字符集收窄到 `0-9a-f`，正好是 hex。

- [ ] **Step 4: 实现 Database**

`infra-aws/lib/database.ts`：

```typescript
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import { Construct } from "constructs";

export interface DatabaseProps {
	readonly vpc: ec2.Vpc;
}

export class Database extends Construct {
	readonly cluster: rds.DatabaseCluster;
	readonly securityGroup: ec2.SecurityGroup;

	constructor(scope: Construct, id: string, props: DatabaseProps) {
		super(scope, id);

		this.securityGroup = new ec2.SecurityGroup(this, "Sg", {
			vpc: props.vpc,
			description: "Aurora, reachable only from Fargate tasks",
			allowAllOutbound: false,
		});

		const engine = rds.DatabaseClusterEngine.auroraMysql({
			version: rds.AuroraMysqlEngineVersion.VER_3_08_0,
		});

		const parameterGroup = new rds.ParameterGroup(this, "ClusterParams", {
			engine,
			parameters: { require_secure_transport: "ON" },
		});

		this.cluster = new rds.DatabaseCluster(this, "Cluster", {
			engine,
			vpc: props.vpc,
			vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
			securityGroups: [this.securityGroup],
			writer: rds.ClusterInstance.serverlessV2("Writer", {
				publiclyAccessible: false,
			}),
			serverlessV2MinCapacity: 0.5,
			serverlessV2MaxCapacity: 4,
			defaultDatabaseName: "cap",
			credentials: rds.Credentials.fromGeneratedSecret("capadmin"),
			parameterGroup,
			storageEncrypted: true,
			backup: { retention: cdk.Duration.days(7) },
			removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
		});
	}
}
```

若 `VER_3_08_0` 在当前 CDK 版本不存在，用 `rds.AuroraMysqlEngineVersion.of("8.0.mysql_aurora.3.08.0", "8.0")` 替代，或选一个该版本里存在的 3.x 常量——必须是 MySQL 8.0 兼容的 Aurora 3.x。

- [ ] **Step 5: 接入 stack**

在 `storage` 之后加：

```typescript
		const secrets = new AppSecrets(this, "Secrets");
		const database = new Database(this, "Database", { vpc: network.vpc });

		new cdk.CfnOutput(this, "DatabaseEndpoint", {
			value: database.cluster.clusterEndpoint.hostname,
		});
		new cdk.CfnOutput(this, "DatabaseCredentialsSecretArn", {
			value: database.cluster.secret?.secretArn ?? "none",
		});
		new cdk.CfnOutput(this, "DatabaseUrlSecretArn", {
			value: secrets.databaseUrl.secretArn,
		});
		new cdk.CfnOutput(this, "CloudFrontPrivateKeySecretArn", {
			value: secrets.cloudFrontPrivateKey.secretArn,
		});
```

顶部加 `import { AppSecrets } from "./secrets.js";` 与 `import { Database } from "./database.js";`

- [ ] **Step 6: 运行全部测试**

```bash
cd infra-aws
export CAP_CLOUDFRONT_PUBLIC_KEY="$(cat /home/ec2-user/.claude/jobs/030daad0/tmp/cf-keys/public_key.pem)"
pnpm test
```

Expected: database 5 个 PASS，之前 15 个仍 PASS

- [ ] **Step 7: 格式化并提交**

```bash
cd /home/ec2-user/research/cap
pnpm exec biome check --write infra-aws
git add infra-aws
git commit -m "feat(infra-aws): add Aurora Serverless v2 with TLS enforced and app secrets"
```

---

## Task 6: ECR 仓库与镜像构建

**不能 mirror 上游的 ghcr 镜像。** `apps/web/Dockerfile:14` 把 `ENV NEXT_PUBLIC_WEB_URL=http://localhost:3000` 设在 `pnpm run build:web` **之前**，而 `NEXT_PUBLIC_*` 是构建期内联进产物的。用上游镜像的后果是分享链接全部指向 localhost：

- `apps/web/app/(org)/dashboard/caps/components/CapCard/CapCard.tsx:370` — `${webUrl}/s/${cap.id}`
- `apps/web/app/(org)/dashboard/caps/components/SharingDialog.tsx:646` — 嵌入代码
- `CapCard.tsx:336` — 预览图 URL

也就是说核心功能直接坏掉。所以两个镜像都自己构建，并把 `NEXT_PUBLIC_WEB_URL` 参数化。这带来一个**部署顺序约束**：镜像必须在拿到 App CloudFront 域名之后才能构建，见 Task 8。

**Files:**
- Create: `infra-aws/lib/registry.ts`
- Create: `infra-aws/scripts/build-images.sh`
- Modify: `apps/web/Dockerfile:13-14`（两行，把 ENV 改成可传入的 ARG）
- Modify: `infra-aws/lib/cap-stack.ts`
- Test: `infra-aws/test/registry.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `class Registry extends Construct`，暴露 `readonly web: ecr.Repository`、`readonly mediaServer: ecr.Repository`、`readonly whisper: ecr.Repository`（Task 18 用）

- [ ] **Step 1: 写失败测试**

`infra-aws/test/registry.test.ts`：

```typescript
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { CapStack } from "../lib/cap-stack.js";
import { CONFIG } from "../lib/config.js";

let template: Template;

beforeAll(() => {
	process.env.CAP_CLOUDFRONT_PUBLIC_KEY = [
		"-----BEGIN PUBLIC KEY-----",
		"MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtest",
		"-----END PUBLIC KEY-----",
	].join("\n");

	const app = new cdk.App();
	const stack = new CapStack(app, "TestStack", {
		env: { account: "123456789012", region: CONFIG.region },
	});
	template = Template.fromStack(stack);
});

describe("Registry", () => {
	it("建三个 ECR 仓库", () => {
		template.resourceCountIs("AWS::ECR::Repository", 3);
	});

	it("推送时扫描镜像", () => {
		const repos = Object.values(template.findResources("AWS::ECR::Repository"));
		for (const repo of repos) {
			expect(repo.Properties?.ImageScanningConfiguration).toEqual({
				ScanOnPush: true,
			});
		}
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd infra-aws && pnpm test test/registry.test.ts`
Expected: FAIL — 期望 3 个 ECR 仓库，找到 0 个

- [ ] **Step 3: 实现 Registry**

`infra-aws/lib/registry.ts`：

```typescript
import * as cdk from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import { Construct } from "constructs";

function repository(scope: Construct, id: string): ecr.Repository {
	return new ecr.Repository(scope, id, {
		imageScanOnPush: true,
		imageTagMutability: ecr.TagMutability.MUTABLE,
		removalPolicy: cdk.RemovalPolicy.RETAIN,
		lifecycleRules: [{ maxImageCount: 10 }],
	});
}

export class Registry extends Construct {
	readonly web: ecr.Repository;
	readonly mediaServer: ecr.Repository;
	readonly whisper: ecr.Repository;

	constructor(scope: Construct, id: string) {
		super(scope, id);

		this.web = repository(this, "Web");
		this.mediaServer = repository(this, "MediaServer");
		this.whisper = repository(this, "Whisper");
	}
}
```

- [ ] **Step 4: 把 Dockerfile 的 web URL 参数化**

`apps/web/Dockerfile` 第 13–14 行，把写死的 ENV 改成有默认值的 ARG。这是两行改动、语义上纯粹是改进（默认行为不变），而且是个可以回贡献给上游的候选 PR。

改动前：

```dockerfile
ARG NEXT_PUBLIC_DOCKER_BUILD=true
ENV NEXT_PUBLIC_WEB_URL=http://localhost:3000
```

改动后：

```dockerfile
ARG NEXT_PUBLIC_DOCKER_BUILD=true
ARG NEXT_PUBLIC_WEB_URL=http://localhost:3000
ENV NEXT_PUBLIC_WEB_URL=$NEXT_PUBLIC_WEB_URL
```

- [ ] **Step 5: 写构建脚本**

`infra-aws/scripts/build-images.sh`：

```bash
#!/usr/bin/env bash
# Build cap-web and media-server images and push them to ECR.
#
# cap-web must be built with the real public web URL: NEXT_PUBLIC_WEB_URL is
# inlined at build time, and share links / embed codes are generated from it.
# Run this only after `cdk deploy` has produced the App CloudFront domain.
#
# Usage: ./scripts/build-images.sh <account-id> <web-repo> <media-repo> <web-url>
set -euo pipefail

ACCOUNT="${1:?account id required}"
WEB_REPO="${2:?web repo name required}"
MEDIA_REPO="${3:?media repo name required}"
WEB_URL="${4:?web url required, eg. https://dxxxx.cloudfront.net}"
REGION="us-east-1"
REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

aws ecr get-login-password --region "$REGION" \
	| docker login --username AWS --password-stdin "$REGISTRY"

echo "--- building cap-web with NEXT_PUBLIC_WEB_URL=${WEB_URL}"
docker build \
	-f "${REPO_ROOT}/apps/web/Dockerfile" \
	--build-arg "NEXT_PUBLIC_WEB_URL=${WEB_URL}" \
	-t "${REGISTRY}/${WEB_REPO}:latest" \
	"${REPO_ROOT}"
docker push "${REGISTRY}/${WEB_REPO}:latest"

echo "--- building media-server"
docker build \
	-f "${REPO_ROOT}/apps/media-server/Dockerfile.standalone" \
	-t "${REGISTRY}/${MEDIA_REPO}:latest" \
	"${REPO_ROOT}/apps/media-server"
docker push "${REGISTRY}/${MEDIA_REPO}:latest"

echo "--- done"
```

```bash
chmod +x infra-aws/scripts/build-images.sh
```

注意 cap-web 的构建上下文是**仓库根目录**（Dockerfile 里是 `COPY . .`），media-server 的上下文是 `apps/media-server`。

- [ ] **Step 6: 接入 stack 并运行测试**

在 `database` 之后加 `const registry = new Registry(this, "Registry");`，顶部加 import，并输出仓库 URI：

```typescript
		new cdk.CfnOutput(this, "WebRepositoryUri", {
			value: registry.web.repositoryUri,
		});
		new cdk.CfnOutput(this, "MediaServerRepositoryUri", {
			value: registry.mediaServer.repositoryUri,
		});
		new cdk.CfnOutput(this, "WhisperRepositoryUri", {
			value: registry.whisper.repositoryUri,
		});
```

```bash
cd infra-aws
export CAP_CLOUDFRONT_PUBLIC_KEY="$(cat /home/ec2-user/.claude/jobs/030daad0/tmp/cf-keys/public_key.pem)"
pnpm test
```

Expected: registry 2 个 PASS，之前 20 个仍 PASS

- [ ] **Step 7: 格式化并提交**

```bash
cd /home/ec2-user/research/cap
pnpm exec biome check --write infra-aws
git add infra-aws apps/web/Dockerfile
git commit -m "feat(infra-aws): add ECR repositories and parameterised image build

NEXT_PUBLIC_WEB_URL is inlined at build time, so the upstream ghcr image
bakes in localhost:3000 and every generated share link points there. Make
it a build arg and build our own image instead of mirroring."
```

---

## Task 7: ECS 计算层（cap-web + media-server）

两个服务放一个 task：它们共用 cluster 与 Service Connect 命名空间，且「两个服务都起来」才是一个可独立验证的交付物。cap-web 单独上线时 `MEDIA_SERVER_URL` 指向不存在的服务，不构成有意义的中间态。

**Files:**
- Create: `infra-aws/lib/compute.ts`
- Modify: `infra-aws/lib/cap-stack.ts`
- Test: `infra-aws/test/compute.test.ts`

**Interfaces:**
- Consumes: `Network.vpc`、`FrontDoor.listener` / `appUrl`、`Storage.bucket` / `bucketUrl` / `distribution` / `keyPairId`、`Database.cluster` / `securityGroup`、`AppSecrets`、`Registry.web` / `mediaServer`
- Produces: `class Compute extends Construct`，暴露 `readonly cluster: ecs.Cluster`（Task 18 的 Whisper task definition 用）、`readonly taskRole: iam.Role`（Task 18 加 `ecs:RunTask` 权限）、`readonly webService: ecs.FargateService`

- [ ] **Step 1: 写失败测试**

`infra-aws/test/compute.test.ts`：

```typescript
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { CapStack } from "../lib/cap-stack.js";
import { CONFIG } from "../lib/config.js";

let template: Template;

beforeAll(() => {
	process.env.CAP_CLOUDFRONT_PUBLIC_KEY = [
		"-----BEGIN PUBLIC KEY-----",
		"MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtest",
		"-----END PUBLIC KEY-----",
	].join("\n");

	const app = new cdk.App();
	const stack = new CapStack(app, "TestStack", {
		env: { account: "123456789012", region: CONFIG.region },
	});
	template = Template.fromStack(stack);
});

const taskDefs = () =>
	Object.values(template.findResources("AWS::ECS::TaskDefinition"));

describe("Compute", () => {
	it("建两个 Fargate 服务", () => {
		template.resourceCountIs("AWS::ECS::Service", 2);
	});

	it("S3_PATH_STYLE 为 false（默认 true 是给 MinIO 的）", () => {
		const env = taskDefs()
			.flatMap(
				(def) => (def.Properties?.ContainerDefinitions as unknown[]) ?? [],
			)
			.flatMap(
				(container) =>
					((container as Record<string, unknown>).Environment as Array<{
						Name: string;
						Value: string;
					}>) ?? [],
			);
		const pathStyle = env.find((e) => e.Name === "S3_PATH_STYLE");
		expect(pathStyle?.Value).toBe("false");
	});

	it("NEXT_PUBLIC_IS_CAP 绝不出现（它会重新开启 Pro 门槛）", () => {
		expect(JSON.stringify(taskDefs())).not.toContain("NEXT_PUBLIC_IS_CAP");
	});

	it("敏感值走 secrets 注入而非明文 environment", () => {
		const json = JSON.stringify(taskDefs());
		expect(json).toContain("NEXTAUTH_SECRET");
		// 明文 environment 项的形状是 {"Name":...,"Value":...}；
		// secrets 注入的形状是 {"Name":...,"ValueFrom":...}
		expect(json).toContain("ValueFrom");
	});

	it("Task Role 能读写桶并调 Bedrock", () => {
		const json = JSON.stringify(
			Object.values(template.findResources("AWS::IAM::Policy")),
		);
		expect(json).toContain("s3:PutObject");
		expect(json).toContain("bedrock:InvokeModel");
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd infra-aws && pnpm test test/compute.test.ts`
Expected: FAIL — 期望 2 个 `AWS::ECS::Service`，找到 0 个

- [ ] **Step 3: 实现 Compute construct**

`infra-aws/lib/compute.ts`：

```typescript
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import type { AppSecrets } from "./secrets.js";
import type { Database } from "./database.js";
import type { Storage } from "./storage.js";

const NAMESPACE = "cap.local";
const MEDIA_SERVER_DNS = "media-server";
const MEDIA_SERVER_PORT = 3456;
const WEB_PORT = 3000;

export interface ComputeProps {
	readonly vpc: ec2.Vpc;
	readonly listener: elbv2.ApplicationListener;
	readonly appUrl: string;
	readonly storage: Storage;
	readonly database: Database;
	readonly secrets: AppSecrets;
	readonly webRepository: ecr.Repository;
	readonly mediaServerRepository: ecr.Repository;
}

export class Compute extends Construct {
	readonly cluster: ecs.Cluster;
	readonly taskRole: iam.Role;
	readonly webService: ecs.FargateService;

	constructor(scope: Construct, id: string, props: ComputeProps) {
		super(scope, id);

		this.cluster = new ecs.Cluster(this, "Cluster", {
			vpc: props.vpc,
			containerInsightsV2: ecs.ContainerInsights.ENABLED,
			defaultCloudMapNamespace: {
				name: NAMESPACE,
				useForServiceConnect: true,
			},
		});

		this.taskRole = new iam.Role(this, "TaskRole", {
			assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
		});

		props.storage.bucket.grantReadWrite(this.taskRole);
		this.taskRole.addToPolicy(
			new iam.PolicyStatement({
				actions: ["cloudfront:CreateInvalidation"],
				resources: [
					cdk.Stack.of(this).formatArn({
						service: "cloudfront",
						region: "",
						resource: "distribution",
						resourceName: props.storage.distribution.distributionId,
					}),
				],
			}),
		);
		// Bedrock 现在就授权：它不依赖任何本 stack 内的资源，
		// Task 19 只改应用代码，不必回来动 IAM。
		this.taskRole.addToPolicy(
			new iam.PolicyStatement({
				actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
				resources: ["*"],
			}),
		);

		const webSecurityGroup = new ec2.SecurityGroup(this, "WebSg", {
			vpc: props.vpc,
			allowAllOutbound: true,
		});
		const mediaSecurityGroup = new ec2.SecurityGroup(this, "MediaSg", {
			vpc: props.vpc,
			allowAllOutbound: true,
		});

		props.database.securityGroup.addIngressRule(
			webSecurityGroup,
			ec2.Port.tcp(3306),
			"cap-web to Aurora",
		);

		const commonSecrets = {
			NEXTAUTH_SECRET: ecs.Secret.fromSecretsManager(
				props.secrets.nextAuthSecret,
			),
			DATABASE_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(
				props.secrets.databaseEncryptionKey,
			),
			MEDIA_SERVER_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(
				props.secrets.mediaServerWebhookSecret,
			),
		};

		// --- cap-web ---
		const webTask = new ecs.FargateTaskDefinition(this, "WebTask", {
			cpu: 1024,
			memoryLimitMiB: 2048,
			taskRole: this.taskRole,
		});

		webTask.addContainer("web", {
			image: ecs.ContainerImage.fromEcrRepository(props.webRepository, "latest"),
			logging: ecs.LogDrivers.awsLogs({
				streamPrefix: "cap-web",
				logRetention: logs.RetentionDays.ONE_MONTH,
			}),
			portMappings: [{ name: "web", containerPort: WEB_PORT }],
			environment: {
				WEB_URL: props.appUrl,
				NEXTAUTH_URL: props.appUrl,
				CAP_AWS_BUCKET: props.storage.bucket.bucketName,
				CAP_AWS_REGION: cdk.Stack.of(this).region,
				// 默认值 true 是给 MinIO 的；真 S3 需要 virtual-hosted style
				S3_PATH_STYLE: "false",
				CAP_AWS_BUCKET_URL: props.storage.bucketUrl,
				CAP_CLOUDFRONT_DISTRIBUTION_ID:
					props.storage.distribution.distributionId,
				CLOUDFRONT_KEYPAIR_ID: props.storage.keyPairId,
				MEDIA_SERVER_URL: `http://${MEDIA_SERVER_DNS}:${MEDIA_SERVER_PORT}`,
				MEDIA_SERVER_WEBHOOK_URL: `http://cap-web:${WEB_PORT}`,
			},
			secrets: {
				...commonSecrets,
				DATABASE_URL: ecs.Secret.fromSecretsManager(props.secrets.databaseUrl),
				CLOUDFRONT_KEYPAIR_PRIVATE_KEY: ecs.Secret.fromSecretsManager(
					props.secrets.cloudFrontPrivateKey,
				),
			},
		});

		this.webService = new ecs.FargateService(this, "WebService", {
			cluster: this.cluster,
			taskDefinition: webTask,
			desiredCount: 1,
			securityGroups: [webSecurityGroup],
			vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
			serviceConnectConfiguration: { namespace: NAMESPACE },
			circuitBreaker: { rollback: true },
		});

		props.listener.addTargets("WebTarget", {
			port: WEB_PORT,
			protocol: elbv2.ApplicationProtocol.HTTP,
			targets: [this.webService],
			healthCheck: {
				path: "/",
				healthyThresholdCount: 2,
				interval: cdk.Duration.seconds(30),
				timeout: cdk.Duration.seconds(10),
			},
			deregistrationDelay: cdk.Duration.seconds(30),
			priority: 1,
			conditions: [elbv2.ListenerCondition.pathPatterns(["/*"])],
		});

		// --- media-server ---
		const mediaTask = new ecs.FargateTaskDefinition(this, "MediaTask", {
			cpu: 2048,
			memoryLimitMiB: 4096,
			taskRole: this.taskRole,
		});

		mediaTask.addContainer("media-server", {
			image: ecs.ContainerImage.fromEcrRepository(
				props.mediaServerRepository,
				"latest",
			),
			logging: ecs.LogDrivers.awsLogs({
				streamPrefix: "cap-media-server",
				logRetention: logs.RetentionDays.ONE_MONTH,
			}),
			portMappings: [{ name: "media", containerPort: MEDIA_SERVER_PORT }],
			environment: { PORT: String(MEDIA_SERVER_PORT) },
			secrets: {
				MEDIA_SERVER_WEBHOOK_SECRET: commonSecrets.MEDIA_SERVER_WEBHOOK_SECRET,
			},
		});

		const mediaService = new ecs.FargateService(this, "MediaService", {
			cluster: this.cluster,
			taskDefinition: mediaTask,
			desiredCount: 1,
			securityGroups: [mediaSecurityGroup],
			vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
			serviceConnectConfiguration: {
				namespace: NAMESPACE,
				services: [
					{
						portMappingName: "media",
						dnsName: MEDIA_SERVER_DNS,
						port: MEDIA_SERVER_PORT,
					},
				],
			},
			circuitBreaker: { rollback: true },
		});

		mediaSecurityGroup.addIngressRule(
			webSecurityGroup,
			ec2.Port.tcp(MEDIA_SERVER_PORT),
			"cap-web to media-server",
		);
		void mediaService;
	}
}
```

`void mediaService;` 是为了满足 Biome 的未使用变量规则——若后续 task 需要引用它，改成 `readonly mediaService` 字段并删掉这行。

- [ ] **Step 4: 接入 stack**

在 `registry` 之后加：

```typescript
		new Compute(this, "Compute", {
			vpc: network.vpc,
			listener: frontDoor.listener,
			appUrl: frontDoor.appUrl,
			storage,
			database,
			secrets,
			webRepository: registry.web,
			mediaServerRepository: registry.mediaServer,
		});
```

顶部加 `import { Compute } from "./compute.js";`

- [ ] **Step 5: 运行全部测试**

```bash
cd infra-aws
export CAP_CLOUDFRONT_PUBLIC_KEY="$(cat /home/ec2-user/.claude/jobs/030daad0/tmp/cf-keys/public_key.pem)"
pnpm test
```

Expected: compute 5 个 PASS，之前 22 个仍 PASS。**security 的 task definition 断言此时生效**——若不小心加了 `CAP_AWS_ACCESS_KEY` 就会红

- [ ] **Step 6: 格式化并提交**

```bash
cd /home/ec2-user/research/cap
pnpm exec biome check --write infra-aws
git add infra-aws
git commit -m "feat(infra-aws): add ECS services for cap-web and media-server"
```

---

## Task 8: 首次部署与验证

这个 task 没有单元测试——它的验收是真实的 HTTP 响应。部署顺序有硬约束：**镜像必须在拿到 App CloudFront 域名之后才能构建**（Task 6 的原因）。

**Files:** 无代码改动

**Interfaces:**
- Consumes: Task 1–7 的全部产出
- Produces: 一个可访问的登录页；`AppUrl` 输出值供 Task 9（Cognito 回调）、Task 13（桌面端）使用

- [ ] **Step 1: 确认 AWS 凭据与 region**

```bash
aws sts get-caller-identity
aws configure get region
```

Expected: 打印账号 ID；region 为 `us-east-1`（否则显式带 `--region us-east-1`）

- [ ] **Step 2: bootstrap CDK**

```bash
cd infra-aws
export CAP_CLOUDFRONT_PUBLIC_KEY="$(cat /home/ec2-user/.claude/jobs/030daad0/tmp/cf-keys/public_key.pem)"
pnpm exec cdk bootstrap "aws://$(aws sts get-caller-identity --query Account --output text)/us-east-1"
```

Expected: `✅ Environment bootstrapped`

- [ ] **Step 3: 首次部署**

服务会因为 ECR 里还没有镜像而反复拉取失败——**这是预期行为**，不要以为部署坏了。

```bash
cd infra-aws && pnpm exec cdk deploy --require-approval never --outputs-file outputs.json
cat outputs.json
```

Expected: 部署成功，`outputs.json` 含 `AppUrl`、`BucketName`、`WebRepositoryUri`、`DatabaseEndpoint`、`DatabaseUrlSecretArn`、`CloudFrontPrivateKeySecretArn` 等

> `outputs.json` 含账号信息，加进 `infra-aws/.gitignore`，不要提交。

- [ ] **Step 4: 填入两个手工 secret**

CloudFront 私钥：

```bash
aws secretsmanager put-secret-value \
	--secret-id "$(jq -r .CapStack.CloudFrontPrivateKeySecretArn infra-aws/outputs.json)" \
	--secret-string "$(cat /home/ec2-user/.claude/jobs/030daad0/tmp/cf-keys/private_key.pem)" \
	--region us-east-1
```

`DATABASE_URL`（从 Aurora 自动生成的凭据 secret 里取密码，拼出带 TLS 参数的 URL）：

```bash
DB_SECRET=$(jq -r .CapStack.DatabaseCredentialsSecretArn infra-aws/outputs.json)
DB_HOST=$(jq -r .CapStack.DatabaseEndpoint infra-aws/outputs.json)
DB_PASS=$(aws secretsmanager get-secret-value --secret-id "$DB_SECRET" \
	--query SecretString --output text --region us-east-1 | jq -r .password)

aws secretsmanager put-secret-value \
	--secret-id "$(jq -r .CapStack.DatabaseUrlSecretArn infra-aws/outputs.json)" \
	--secret-string "mysql://capadmin:${DB_PASS}@${DB_HOST}:3306/cap?ssl={\"rejectUnauthorized\":true}" \
	--region us-east-1
```

密码里可能含 URL 保留字符。若连接报错，改用 `jq -rn --arg p "$DB_PASS" '$p|@uri'` 做百分号编码后再拼。

```bash
unset DB_PASS
rm -rf /home/ec2-user/.claude/jobs/030daad0/tmp/cf-keys
```

- [ ] **Step 5: 构建并推送镜像**

```bash
cd /home/ec2-user/research/cap
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
APP_URL=$(jq -r .CapStack.AppUrl infra-aws/outputs.json)
WEB_REPO=$(jq -r .CapStack.WebRepositoryUri infra-aws/outputs.json | cut -d/ -f2-)
MEDIA_REPO=$(jq -r .CapStack.MediaServerRepositoryUri infra-aws/outputs.json | cut -d/ -f2-)

./infra-aws/scripts/build-images.sh "$ACCOUNT" "$WEB_REPO" "$MEDIA_REPO" "$APP_URL"
```

Expected: 两个镜像推送成功。cap-web 的构建会跑完整个 `pnpm run build:web`，耗时较长

- [ ] **Step 6: 强制重新部署服务**

```bash
CLUSTER=$(aws ecs list-clusters --region us-east-1 \
	--query "clusterArns[?contains(@,'CapStack')]|[0]" --output text)
for svc in $(aws ecs list-services --cluster "$CLUSTER" --region us-east-1 \
	--query 'serviceArns[]' --output text); do
	aws ecs update-service --cluster "$CLUSTER" --service "$svc" \
		--force-new-deployment --region us-east-1 >/dev/null
done
aws ecs wait services-stable --cluster "$CLUSTER" \
	--services $(aws ecs list-services --cluster "$CLUSTER" --region us-east-1 \
		--query 'serviceArns[]' --output text) --region us-east-1
```

Expected: 两个服务达到 stable

- [ ] **Step 7: 验证登录页可达**

```bash
APP_URL=$(jq -r .CapStack.AppUrl infra-aws/outputs.json)
curl -sS -o /dev/null -w '%{http_code}\n' "$APP_URL/login"
```

Expected: `200`

若返回 503：检查 ALB 目标组健康状态与 cap-web 日志（多半是 `DATABASE_URL` 连不上——确认 TLS 参数和密码编码）。
若卡在 CloudFront 层（504）：`VpcOrigin` 可能不通，此时执行「跨阶段依赖」第 1 条的退路。

- [ ] **Step 8: 验证桶确实不可公开访问**

```bash
BUCKET=$(jq -r .CapStack.BucketName infra-aws/outputs.json)
aws s3api get-public-access-block --bucket "$BUCKET" --region us-east-1
curl -sS -o /dev/null -w '%{http_code}\n' "https://${BUCKET}.s3.amazonaws.com/"
```

Expected: 四个 block 项全为 `true`；匿名 curl 返回 `403`

- [ ] **Step 9: 提交 gitignore**

```bash
cd /home/ec2-user/research/cap
printf 'outputs.json\ncdk.out/\nnode_modules/\n' > infra-aws/.gitignore
git add infra-aws/.gitignore
git commit -m "chore(infra-aws): ignore cdk outputs and build artefacts"
```

---

## Task 9: Cognito user pool（CDK）

**Files:**
- Create: `infra-aws/lib/auth.ts`
- Modify: `infra-aws/lib/cap-stack.ts`
- Test: `infra-aws/test/auth.test.ts`

**Interfaces:**
- Consumes: `FrontDoor.appUrl`
- Produces: `class Auth extends Construct`，暴露 `readonly userPool: cognito.UserPool`、`readonly client: cognito.UserPoolClient`、`readonly issuer: string`（`https://cognito-idp.<region>.amazonaws.com/<poolId>`）、`readonly clientSecret: cdk.SecretValue`

- [ ] **Step 1: 写失败测试**

`infra-aws/test/auth.test.ts`：

```typescript
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { CapStack } from "../lib/cap-stack.js";
import { CONFIG } from "../lib/config.js";

let template: Template;

beforeAll(() => {
	process.env.CAP_CLOUDFRONT_PUBLIC_KEY = [
		"-----BEGIN PUBLIC KEY-----",
		"MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtest",
		"-----END PUBLIC KEY-----",
	].join("\n");

	const app = new cdk.App();
	const stack = new CapStack(app, "TestStack", {
		env: { account: "123456789012", region: CONFIG.region },
	});
	template = Template.fromStack(stack);
});

describe("Auth", () => {
	it("建一个以邮箱登录、自助验证邮箱的 user pool", () => {
		template.hasResourceProperties("AWS::Cognito::UserPool", {
			UsernameAttributes: ["email"],
			AutoVerifiedAttributes: ["email"],
		});
	});

	it("app client 带 secret 且只开 authorization code flow", () => {
		template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
			GenerateSecret: true,
			AllowedOAuthFlows: ["code"],
		});
	});

	it("回调 URL 指向 NextAuth 的 cognito callback 路径", () => {
		const clients = Object.values(
			template.findResources("AWS::Cognito::UserPoolClient"),
		);
		const json = JSON.stringify(clients);
		expect(json).toContain("/api/auth/callback/cognito");
	});

	it("有 hosted UI 域名", () => {
		template.resourceCountIs("AWS::Cognito::UserPoolDomain", 1);
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd infra-aws && pnpm test test/auth.test.ts`
Expected: FAIL — 找不到 `AWS::Cognito::UserPool`

- [ ] **Step 3: 实现 Auth construct**

`infra-aws/lib/auth.ts`：

```typescript
import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";

export interface AuthProps {
	/** App CloudFront 的 https URL */
	readonly appUrl: string;
	/** hosted UI 域名前缀，必须全局唯一 */
	readonly domainPrefix: string;
}

export class Auth extends Construct {
	readonly userPool: cognito.UserPool;
	readonly client: cognito.UserPoolClient;

	constructor(scope: Construct, id: string, props: AuthProps) {
		super(scope, id);

		this.userPool = new cognito.UserPool(this, "UserPool", {
			signInAliases: { email: true },
			autoVerify: { email: true },
			selfSignUpEnabled: true,
			// Cognito 自带发信，每日 50 封上限，小团队够用；
			// 这样注册验证码不依赖 SES，也就绕开了 SES 沙箱。
			email: cognito.UserPoolEmail.withCognito(),
			standardAttributes: {
				email: { required: true, mutable: false },
			},
			passwordPolicy: {
				minLength: 12,
				requireLowercase: true,
				requireUppercase: true,
				requireDigits: true,
				requireSymbols: false,
			},
			mfa: cognito.Mfa.OPTIONAL,
			mfaSecondFactor: { sms: false, otp: true },
			accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
			removalPolicy: cdk.RemovalPolicy.RETAIN,
		});

		this.userPool.addDomain("HostedUi", {
			cognitoDomain: { domainPrefix: props.domainPrefix },
		});

		this.client = this.userPool.addClient("WebClient", {
			generateSecret: true,
			authFlows: { userSrp: true },
			oAuth: {
				flows: { authorizationCodeGrant: true },
				scopes: [
					cognito.OAuthScope.OPENID,
					cognito.OAuthScope.EMAIL,
					cognito.OAuthScope.PROFILE,
				],
				callbackUrls: [`${props.appUrl}/api/auth/callback/cognito`],
				logoutUrls: [`${props.appUrl}/login`],
			},
			preventUserExistenceErrors: true,
		});
	}

	get issuer(): string {
		const stack = cdk.Stack.of(this);
		return `https://cognito-idp.${stack.region}.amazonaws.com/${this.userPool.userPoolId}`;
	}

	get clientSecret(): cdk.SecretValue {
		return this.client.userPoolClientSecret;
	}
}
```

- [ ] **Step 4: 接入 stack 并把 Cognito 配置注入 cap-web**

`domainPrefix` 必须全局唯一，用账号 ID 后缀避免撞名。在 `cap-stack.ts` 里 `registry` 之后、`Compute` 之前加：

```typescript
		const auth = new Auth(this, "Auth", {
			appUrl: frontDoor.appUrl,
			domainPrefix: `cap-${cdk.Stack.of(this).account}`,
		});
```

`Compute` 的 props 增加 `auth`，并在 `compute.ts` 的 `ComputeProps` 里加 `readonly auth: Auth;`，然后在 cap-web 容器的 `environment` 里加：

```typescript
				COGNITO_ISSUER: props.auth.issuer,
				COGNITO_CLIENT_ID: props.auth.client.userPoolClientId,
```

`secrets` 里不能直接放 `SecretValue`——`ecs.Secret` 只接 Secrets Manager 或 SSM。因此把 client secret 明文放进 `environment` 是**不可接受**的。改为：在 `auth.ts` 里额外建一个 Secrets Manager secret 承载它。在 `Auth` 构造函数末尾加：

```typescript
		this.clientSecretParameter = new secretsmanager.Secret(
			this,
			"ClientSecret",
			{
				secretStringValue: this.client.userPoolClientSecret,
			},
		);
```

字段声明 `readonly clientSecretParameter: secretsmanager.Secret;`，顶部加 `import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";`，并删掉上面那个 `get clientSecret()`。然后 cap-web 的 `secrets` 加：

```typescript
				COGNITO_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
					props.auth.clientSecretParameter,
				),
```

输出：

```typescript
		new cdk.CfnOutput(this, "CognitoIssuer", { value: auth.issuer });
		new cdk.CfnOutput(this, "CognitoClientId", {
			value: auth.client.userPoolClientId,
		});
```

- [ ] **Step 5: 运行全部测试**

```bash
cd infra-aws
export CAP_CLOUDFRONT_PUBLIC_KEY="$(cat public_key.pem 2>/dev/null || echo '-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtest
-----END PUBLIC KEY-----')"
pnpm test
```

Expected: auth 4 个 PASS，之前 27 个仍 PASS。**security 的 secrets 计数断言会变**——`database.test.ts` 里那条 `resourceCountIs("AWS::SecretsManager::Secret", 6)` 需要改成 7（多了 Cognito client secret）。这是预期的，改掉断言值而不是绕过它

- [ ] **Step 6: 格式化并提交**

```bash
cd /home/ec2-user/research/cap
pnpm exec biome check --write infra-aws
git add infra-aws
git commit -m "feat(infra-aws): add Cognito user pool and wire it into cap-web"
```

---

## Task 10: 应用侧环境变量声明

**Files:**
- Modify: `packages/env/server.ts`

**Interfaces:**
- Consumes: 无
- Produces: `serverEnv()` 上多出 `COGNITO_CLIENT_ID`、`COGNITO_CLIENT_SECRET`、`COGNITO_ISSUER`、`BEDROCK_REGION`、`WHISPER_CLUSTER_ARN`、`WHISPER_TASK_DEFINITION_ARN`、`WHISPER_SUBNET_IDS`、`WHISPER_SECURITY_GROUP_ID`；`AI_PROVIDER` 接受 `"bedrock"`。Task 11、12、16、17、19 全部依赖这些

- [ ] **Step 1: 加 Cognito 三个变量**

在 `packages/env/server.ts` 的 Apple 那段之后（`APPLE_CLIENT_SECRET` 下方）插入：

```typescript
			/// Cognito
			// Self-hosted auth via an Amazon Cognito user pool
			COGNITO_CLIENT_ID: z.string().optional(),
			COGNITO_CLIENT_SECRET: z.string().optional(),
			COGNITO_ISSUER: z
				.string()
				.optional()
				.describe(
					"eg. https://cognito-idp.us-east-1.amazonaws.com/<userPoolId>",
				),
```

- [ ] **Step 2: 给 AI_PROVIDER 的 union 加 bedrock，并加一个显式开关**

这个 union 存在于**两处**，本 step 改 env 侧。找到 `AI_PROVIDER: z.union([...])`（约在第 96 行），在 `z.literal("groq"),` 后加一行：

```typescript
					z.literal("bedrock"),
```

漏掉这处的症状是：`provider.ts` 改对了，但 `AI_PROVIDER=bedrock` 被 env 校验拒绝，报错指向配置而不是代码，很容易查错方向。

再在 `AI_API_KEY` 之后加一个 Bedrock 的显式开关：

```typescript
			BEDROCK_REGION: z
				.string()
				.optional()
				.describe(
					"Enables the 'bedrock' AI provider. Credentials come from the ECS task role, so there is no API key to detect — this is the opt-in marker.",
				),
```

Bedrock 没有 API key（凭据走 Task Role），所以需要一个显式标记，否则 `isProviderConfigured` 无从判断，也无法避免被自动探测顺序选中。

- [ ] **Step 3: 加 Whisper 四个变量**

在 `MEDIA_SERVER_WEBHOOK_URL` 之后插入：

```typescript
			/// Whisper transcription (self-hosted, run as an on-demand ECS task)
			WHISPER_CLUSTER_ARN: z.string().optional(),
			WHISPER_TASK_DEFINITION_ARN: z.string().optional(),
			WHISPER_SUBNET_IDS: z
				.string()
				.optional()
				.describe("Comma-separated private subnet ids for the whisper task"),
			WHISPER_SECURITY_GROUP_ID: z.string().optional(),
```

- [ ] **Step 4: 确认类型检查通过**

```bash
cd /home/ec2-user/research/cap
pnpm exec tsc -b packages/env
```

Expected: 无错误。若 `tsc -b` 对该包不适用，退而用 `pnpm typecheck`（较慢）

- [ ] **Step 5: 格式化并提交**

```bash
pnpm exec biome check --write packages/env/server.ts
git add packages/env/server.ts
git commit -m "feat(env): add Cognito, Whisper and Bedrock configuration"
```

---

## Task 11: NextAuth Cognito provider

**Files:**
- Modify: `packages/database/auth/auth-options.ts`
- Test: `apps/web/__tests__/unit/cognito-auth.test.ts`

**Interfaces:**
- Consumes: Task 10 的 `COGNITO_*` env
- Produces: `authOptions().providers` 在配置齐全时包含 id 为 `"cognito"` 的 provider

**写法约定**：照现有 `AppleProvider` 的条件式写法（第 76–84 行），**不要**学 `GoogleProvider` / `WorkOSProvider` 那种 `serverEnv().X as string` 硬塞——那会在未配置时也把 provider 加进数组。

- [ ] **Step 1: 写失败测试**

`apps/web/__tests__/unit/cognito-auth.test.ts`：

```typescript
import { describe, expect, it, vi } from "vitest";

const serverEnvMock = vi.hoisted(() =>
	vi.fn<() => Record<string, string | undefined>>(() => ({})),
);

vi.mock("@cap/env", () => ({
	serverEnv: serverEnvMock,
	buildEnv: {},
}));

import { authOptions } from "@cap/database/auth/auth-options";

const providerIds = () => authOptions().providers.map((p) => p.id);

describe("Cognito provider", () => {
	it("三个变量齐全时加入 providers", () => {
		serverEnvMock.mockReturnValue({
			NEXTAUTH_SECRET: "secret",
			COGNITO_CLIENT_ID: "client-id",
			COGNITO_CLIENT_SECRET: "client-secret",
			COGNITO_ISSUER: "https://cognito-idp.us-east-1.amazonaws.com/pool",
		});

		expect(providerIds()).toContain("cognito");
	});

	it("缺任何一个变量就不加入（避免半配置状态下暴露坏按钮）", () => {
		serverEnvMock.mockReturnValue({
			NEXTAUTH_SECRET: "secret",
			COGNITO_CLIENT_ID: "client-id",
			COGNITO_CLIENT_SECRET: "client-secret",
		});

		expect(providerIds()).not.toContain("cognito");
	});
});
```

若 `@cap/database/auth/auth-options` 这个导入路径在 `apps/web` 的 vitest alias 下解析不了，改用相对路径 `../../../../packages/database/auth/auth-options.ts`，并确认 `apps/web/vitest.config.ts` 的 `resolve.alias` 是否需要补一项。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/web && pnpm exec vitest run __tests__/unit/cognito-auth.test.ts`
Expected: FAIL — `providerIds()` 不含 `"cognito"`

- [ ] **Step 3: 实现**

`packages/database/auth/auth-options.ts`，在 import 区加（保持 Biome 的 import 排序，`cognito` 在 `apple` 之后、`email` 之前）：

```typescript
import CognitoProvider from "next-auth/providers/cognito";
```

在 `get providers()` 里，`appleClientSecret` 那两行之后加：

```typescript
			const cognitoClientId = serverEnv().COGNITO_CLIENT_ID;
			const cognitoClientSecret = serverEnv().COGNITO_CLIENT_SECRET;
			const cognitoIssuer = serverEnv().COGNITO_ISSUER;
```

在 `_providers = [` 数组里，Apple 那段之后加：

```typescript
				...(cognitoClientId && cognitoClientSecret && cognitoIssuer
					? [
							CognitoProvider({
								clientId: cognitoClientId,
								clientSecret: cognitoClientSecret,
								issuer: cognitoIssuer,
							}),
						]
					: []),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/web && pnpm exec vitest run __tests__/unit/cognito-auth.test.ts`
Expected: 2 个 PASS

- [ ] **Step 5: 确认没有破坏既有 auth 测试**

```bash
cd apps/web && pnpm exec vitest run __tests__/unit
```

Expected: 全部 PASS

- [ ] **Step 6: 格式化并提交**

```bash
cd /home/ec2-user/research/cap
pnpm exec biome check --write packages/database/auth/auth-options.ts apps/web/__tests__/unit/cognito-auth.test.ts
git add packages/database/auth/auth-options.ts apps/web/__tests__/unit/cognito-auth.test.ts
git commit -m "feat(auth): add Cognito provider gated on full configuration"
```

---

## Task 12: 登录页 Cognito 入口

**这里有个不显眼但会让整个 task 白做的坑**：`apps/web/app/(org)/login/form.tsx:524` 把整个第三方登录区块包在 `{(publicEnv.googleAuthAvailable || publicEnv.workosAuthAvailable) && (` 里。我们的部署两者都不配，所以**即使加了按钮，整个区块也不会渲染**。必须同时把 `cognitoAuthAvailable` 加进这个条件。

**Files:**
- Modify: `apps/web/utils/public-env.tsx:5-9`
- Modify: `apps/web/app/Layout/AppProviders.tsx:26-31`
- Modify: `apps/web/app/(org)/login/form.tsx`（handler、prop、区块条件、按钮）

**Interfaces:**
- Consumes: Task 10 的 `COGNITO_CLIENT_ID`
- Produces: `usePublicEnv()` 返回值多出 `cognitoAuthAvailable: boolean`

- [ ] **Step 1: 先读 Next.js 文档**

Global Constraints 要求：动 `apps/web` 前先读改过的 Next.js 文档，尤其是 client component 与 server component 传值的部分。

```bash
ls apps/web/node_modules/next/dist/docs/ 2>/dev/null || ls node_modules/next/dist/docs/
```

阅读其中与 client components / environment variables 相关的条目，确认 `NEXT_PUBLIC_*` 与 server→client 传值的当前约定。

- [ ] **Step 2: 扩展 public env 类型**

`apps/web/utils/public-env.tsx`，把类型改为：

```typescript
type PublicEnvContext = {
	webUrl: string;
	googleAuthAvailable: boolean;
	workosAuthAvailable: boolean;
	cognitoAuthAvailable: boolean;
};
```

- [ ] **Step 3: 传入实际值**

`apps/web/app/Layout/AppProviders.tsx`，在 `googleAuthAvailable` 那行下面加：

```typescript
								cognitoAuthAvailable: !!serverEnv().COGNITO_CLIENT_ID,
```

- [ ] **Step 4: 加 handler**

`apps/web/app/(org)/login/form.tsx`，在 `handleAppleSignIn` 之后加：

```typescript
	const handleCognitoSignIn = useCallback(() => {
		const nextPath = getNextPath();
		trackEvent("auth_started", {
			method: "cognito",
			is_signup: false,
			auth_surface: "login",
		});
		signIn("cognito", {
			...(nextPath ? { callbackUrl: nextPath } : {}),
		});
	}, [getNextPath]);
```

- [ ] **Step 5: 穿透 prop 到 NormalLogin**

`NormalLogin` 的调用处（约第 376 行，`handleGoogleSignIn={handleGoogleSignIn}` 那里）加一行：

```typescript
											handleCognitoSignIn={handleCognitoSignIn}
```

`NormalLogin` 的解构参数与类型（约第 450–467 行）各加一项：

```typescript
	handleCognitoSignIn,
```

```typescript
	handleCognitoSignIn: () => void;
```

- [ ] **Step 6: 放开区块门控并加按钮**

第 524 行的条件改为：

```typescript
			{(publicEnv.googleAuthAvailable ||
				publicEnv.workosAuthAvailable ||
				publicEnv.cognitoAuthAvailable) && (
```

在 Google 按钮那个 `{publicEnv.googleAuthAvailable && !oauthError && (...)}` 块之后加：

```typescript
						{publicEnv.cognitoAuthAvailable && (
							<MotionButton
								variant="gray"
								type="button"
								className="flex gap-2 justify-center items-center w-full text-sm"
								layout
								onClick={handleCognitoSignIn}
								disabled={loading || emailSent}
							>
								<LucideKeyRound size={16} />
								使用公司账号登录
							</MotionButton>
						)}
```

把 `LucideKeyRound` 加进第 13 行的 lucide 导入：

```typescript
import { LucideArrowUpRight, LucideKeyRound } from "lucide-react";
```

- [ ] **Step 7: 类型检查**

```bash
cd /home/ec2-user/research/cap
pnpm exec tsc -b apps/web
```

Expected: 无错误。若报 `cognitoAuthAvailable` 缺失，说明还有别处构造了 `PublicEnvContext`——用 `grep -rn "workosAuthAvailable:" apps/web` 找出所有构造点补齐（已知 `AppProviders.tsx` 一处；`apps/web/app/s/[videoId]/_components/AuthOverlay.tsx` 只消费不构造）

- [ ] **Step 8: 格式化并提交**

```bash
pnpm exec biome check --write apps/web/utils/public-env.tsx apps/web/app/Layout/AppProviders.tsx "apps/web/app/(org)/login/form.tsx"
git add apps/web/utils/public-env.tsx apps/web/app/Layout/AppProviders.tsx "apps/web/app/(org)/login/form.tsx"
git commit -m "feat(web): add Cognito sign-in entry to the login page

The third-party auth block is gated on google/workos availability, so a
Cognito-only deployment rendered no auth section at all. Add cognito to
that condition alongside the button."
```

---

## Task 13: 重新部署并验证 Cognito 登录与桌面端

**Files:** 无代码改动（桌面端只改运行时设置）

**Interfaces:**
- Consumes: Task 8 的部署产物、Task 9–12 的改动
- Produces: 一个同事能登录、能录能看的实例。Task 20 在此基础上验证 AI

- [ ] **Step 1: 重建镜像并部署**

代码改了，镜像要重建。

```bash
cd /home/ec2-user/research/cap
export CAP_CLOUDFRONT_PUBLIC_KEY="$(aws secretsmanager get-secret-value \
	--secret-id "$(jq -r .CapStack.CloudFrontPrivateKeySecretArn infra-aws/outputs.json)" \
	--query SecretString --output text --region us-east-1 >/dev/null && echo skip)"
```

上面这条只是提醒：公钥已经在 CDK 里，重新 synth 需要 `CAP_CLOUDFRONT_PUBLIC_KEY` 环境变量。**把公钥 PEM 存成一个不进仓库的本地文件**（例如 `~/.cap-cf-public-key.pem`）以便后续每次部署复用，然后：

```bash
export CAP_CLOUDFRONT_PUBLIC_KEY="$(cat ~/.cap-cf-public-key.pem)"
cd infra-aws && pnpm exec cdk deploy --require-approval never --outputs-file outputs.json

cd /home/ec2-user/research/cap
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
APP_URL=$(jq -r .CapStack.AppUrl infra-aws/outputs.json)
WEB_REPO=$(jq -r .CapStack.WebRepositoryUri infra-aws/outputs.json | cut -d/ -f2-)
MEDIA_REPO=$(jq -r .CapStack.MediaServerRepositoryUri infra-aws/outputs.json | cut -d/ -f2-)
./infra-aws/scripts/build-images.sh "$ACCOUNT" "$WEB_REPO" "$MEDIA_REPO" "$APP_URL"
```

再按 Task 8 Step 6 的方式 `--force-new-deployment` 并等待 stable。

- [ ] **Step 2: 建一个测试用户**

```bash
POOL_ID=$(aws cognito-idp list-user-pools --max-results 20 --region us-east-1 \
	--query "UserPools[?starts_with(Name,'CapStack')].Id|[0]" --output text)
aws cognito-idp admin-create-user --user-pool-id "$POOL_ID" \
	--username "you@yourcompany.com" \
	--user-attributes Name=email,Value=you@yourcompany.com Name=email_verified,Value=true \
	--region us-east-1
aws cognito-idp admin-set-user-password --user-pool-id "$POOL_ID" \
	--username "you@yourcompany.com" --password 'ChangeMe12345' --permanent \
	--region us-east-1
```

- [ ] **Step 3: 验证登录页出现 Cognito 按钮**

浏览器打开 `$APP_URL/login`。

Expected: 看到「使用公司账号登录」按钮。**没看到就是 Task 12 Step 6 的区块门控没改对**——这是本 task 最可能的失败点。

- [ ] **Step 4: 走完登录流程**

点按钮 → 跳 Cognito hosted UI → 用 Step 2 的账号登录 → 跳回应用 dashboard。

Expected: 落到 dashboard，session 建立。若跳回时报 `redirect_uri_mismatch`，核对 Cognito app client 的 callback URL 与 `$APP_URL/api/auth/callback/cognito` 是否完全一致（含协议、无尾斜杠）。

- [ ] **Step 5: 验证浏览器录制、上传、播放**

在 dashboard 里录一段短视频并分享。

Expected: 录制完成、能播放。用浏览器开发者工具确认播放请求指向 Media distribution 域名且 URL 带 `Signature=` 与 `Key-Pair-Id=` 参数——这证明走的是 CloudFront 签名 URL，而不是意外的公开访问。

- [ ] **Step 6: 验证分享链接不含 localhost**

复制分享链接。

Expected: 形如 `https://dxxxx.cloudfront.net/s/<id>`。**若出现 `http://localhost:3000`，说明镜像不是用 `--build-arg NEXT_PUBLIC_WEB_URL` 构建的**——回到 Task 6/8 重建镜像。

- [ ] **Step 7: 桌面端对接**

在已安装的 Cap 桌面端里：`Settings > General > Self-host > Cap Server URL` 填 `$APP_URL`，点 Update。

Expected: 桌面端能登录（走同一个 Cognito 流程）、能录制、能上传、生成的分享链接在 VPN 外可打开。

桌面端无需重新编译——`apps/desktop/src/utils/web_api.rs` 与 `resolveServerRequestPath` 会把所有请求重定向到配置的地址。若希望把地址固化进安装包，用 `VITE_SERVER_URL=$APP_URL` 重新构建（见 spec §8）。

- [ ] **Step 8: 记录验证结果**

把 Step 3–7 的实际结果（含任何偏差）追加到 `design/superpowers/specs/2026-08-17-cap-aws-selfhost-design.md` 的 §15 未决问题下，或新建 `design/notes/2026-08-17-deploy-log.md`。这份记录是 Task 14 之后排查 AI 问题的基线。

```bash
git add design/
git commit -m "docs: record phase 1-4 deployment verification results"
```

---

## Whisper 块的接口契约（Task 14–18 共用）

Whisper 任务通过环境变量接参、把结果写回 S3，`cap-web` 轮询这个对象。契约固定如下，四个 task 都以此为准：

**任务入参（环境变量）**

| 变量 | 含义 |
| --- | --- |
| `INPUT_BUCKET` / `INPUT_KEY` | 音频对象位置（上游已放在 `${userId}/${videoId}/${tempAudioFilename}`） |
| `OUTPUT_KEY` | 词表 JSON 的写入位置 |
| `LANGUAGE` | 语言码，`auto` 表示自动检测 |
| `WHISPER_MODEL` | 镜像内已烧好的模型名 |

**输出 JSON（`s3://INPUT_BUCKET/OUTPUT_KEY`）**

```json
{
	"language": "zh",
	"model": "medium",
	"durationSeconds": 123.45,
	"words": [{ "text": "你好", "start": 1.2, "end": 1.45, "confidence": 0.93 }]
}
```

**时间单位刻意用秒**，与 Whisper 原生输出一致，让这个 JSON 保持 provider 中立。转成毫秒是 Task 15 在 TS 侧做的事，由单测覆盖——AssemblyAI 用毫秒、Whisper 用秒，这个换算是整个改造里最容易出错的一点，把它放在有测试的地方。

---

## Task 14: Whisper 推理服务（`apps/whisper-server`）

**Files:**
- Create: `apps/whisper-server/pyproject.toml`
- Create: `apps/whisper-server/Dockerfile`
- Create: `apps/whisper-server/src/__init__.py`
- Create: `apps/whisper-server/src/transcribe.py`
- Create: `apps/whisper-server/src/main.py`
- Test: `apps/whisper-server/tests/test_transcribe.py`

**Interfaces:**
- Consumes: 上面的接口契约
- Produces: 一个镜像，按契约读 S3 音频、写 S3 词表 JSON。`words_from_segments(segments) -> list[dict]` 是纯函数，被测试覆盖

- [ ] **Step 1: 写工程文件**

`apps/whisper-server/pyproject.toml`：

```toml
[project]
name = "cap-whisper-server"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
	"faster-whisper>=1.1.0",
	"boto3>=1.35.0",
]

[project.optional-dependencies]
dev = ["pytest>=8.0.0"]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools]
packages = ["src"]
```

`apps/whisper-server/src/__init__.py`：空文件。

- [ ] **Step 2: 写失败测试**

`apps/whisper-server/tests/test_transcribe.py`：

```python
from dataclasses import dataclass

from src.transcribe import words_from_segments


@dataclass
class FakeWord:
    start: float
    end: float
    word: str
    probability: float


@dataclass
class FakeSegment:
    words: list[FakeWord] | None


def test_flattens_segments_and_strips_whitespace():
    segments = [
        FakeSegment(words=[FakeWord(1.2, 1.45, " 你好", 0.93)]),
        FakeSegment(words=[FakeWord(1.5, 1.9, " 世界", 0.88)]),
    ]

    assert words_from_segments(segments) == [
        {"text": "你好", "start": 1.2, "end": 1.45, "confidence": 0.93},
        {"text": "世界", "start": 1.5, "end": 1.9, "confidence": 0.88},
    ]


def test_keeps_seconds_untouched():
    # 秒→毫秒的换算刻意留给 TS 侧（见接口契约），这里绝不能乘 1000
    segments = [FakeSegment(words=[FakeWord(0.5, 0.75, "hi", 0.5)])]

    result = words_from_segments(segments)

    assert result[0]["start"] == 0.5
    assert result[0]["end"] == 0.75


def test_skips_segments_without_word_timestamps():
    segments = [
        FakeSegment(words=None),
        FakeSegment(words=[FakeWord(2.0, 2.2, "ok", 0.9)]),
    ]

    assert words_from_segments(segments) == [
        {"text": "ok", "start": 2.0, "end": 2.2, "confidence": 0.9},
    ]


def test_drops_words_that_are_empty_after_stripping():
    segments = [FakeSegment(words=[FakeWord(1.0, 1.1, "   ", 0.9)])]

    assert words_from_segments(segments) == []
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd apps/whisper-server
uv venv && uv pip install -e ".[dev]"
uv run pytest
```

Expected: FAIL — `ModuleNotFoundError: No module named 'src.transcribe'`

- [ ] **Step 4: 实现纯转换与转写**

`apps/whisper-server/src/transcribe.py`：

```python
"""Whisper transcription reduced to the word list Cap needs."""

from __future__ import annotations

from typing import Any, Iterable


def words_from_segments(segments: Iterable[Any]) -> list[dict[str, Any]]:
    """Flatten faster-whisper segments into Cap's word list.

    Timestamps stay in seconds. The conversion to milliseconds happens on the
    TypeScript side, where it is unit-tested — see the interface contract.
    """
    words: list[dict[str, Any]] = []
    for segment in segments:
        for word in getattr(segment, "words", None) or []:
            text = (word.word or "").strip()
            if not text:
                continue
            words.append(
                {
                    "text": text,
                    "start": word.start,
                    "end": word.end,
                    "confidence": word.probability,
                }
            )
    return words


def transcribe_file(
    path: str, model_name: str, language: str | None
) -> dict[str, Any]:
    from faster_whisper import WhisperModel

    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        path,
        language=language,
        word_timestamps=True,
        vad_filter=True,
    )

    words = words_from_segments(segments)
    return {
        "language": info.language,
        "model": model_name,
        "durationSeconds": info.duration,
        "words": words,
    }
```

`model.transcribe` 返回的 `segments` 是生成器，必须在 `words_from_segments` 里被消费完 `info.duration` 才有值——上面的顺序已经保证了这点（先展开 words，再读 info），不要调换。

- [ ] **Step 5: 实现入口**

`apps/whisper-server/src/main.py`：

```python
"""Entry point for the on-demand Whisper ECS task."""

from __future__ import annotations

import json
import os
import tempfile

import boto3

from src.transcribe import transcribe_file


def require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"{name} is required")
    return value


def main() -> None:
    bucket = require("INPUT_BUCKET")
    input_key = require("INPUT_KEY")
    output_key = require("OUTPUT_KEY")
    model_name = os.environ.get("WHISPER_MODEL", "medium")
    language = os.environ.get("LANGUAGE", "auto")

    s3 = boto3.client("s3")

    with tempfile.NamedTemporaryFile(suffix=".mp4") as audio:
        s3.download_fileobj(bucket, input_key, audio)
        audio.flush()
        result = transcribe_file(
            audio.name,
            model_name,
            None if language in ("", "auto") else language,
        )

    s3.put_object(
        Bucket=bucket,
        Key=output_key,
        Body=json.dumps(result, ensure_ascii=False).encode("utf-8"),
        ContentType="application/json",
    )
    print(f"wrote {len(result['words'])} words to s3://{bucket}/{output_key}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 6: 运行测试确认通过**

```bash
cd apps/whisper-server && uv run pytest
```

Expected: 4 个 PASS

- [ ] **Step 7: 写 Dockerfile（模型烧进镜像）**

`apps/whisper-server/Dockerfile`：

```dockerfile
FROM python:3.12-slim

# ffmpeg as a safety net for the fragmented MP4 that Cap assembles for audio;
# PyAV usually handles it, but a batch task can afford the extra layer.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml ./
RUN pip install --no-cache-dir .

COPY src ./src

# Bake the weights in: an on-demand task must not spend cold-start time
# downloading ~1.5GB from Hugging Face on every invocation.
ARG WHISPER_MODEL=medium
ENV WHISPER_MODEL=$WHISPER_MODEL
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8')"

CMD ["python", "-m", "src.main"]
```

- [ ] **Step 8: 本地验证镜像能跑通一段真实音频**

```bash
cd apps/whisper-server
docker build -t cap-whisper:local .
```

Expected: 构建成功。镜像较大（约 2–3 GB，含权重），属预期

- [ ] **Step 9: 提交**

Python 文件不走 Biome。

```bash
cd /home/ec2-user/research/cap
printf '.venv/\n__pycache__/\n*.egg-info/\n' > apps/whisper-server/.gitignore
git add apps/whisper-server
git commit -m "feat(whisper-server): add on-demand faster-whisper transcription task"
```

---

## Task 15: Whisper 词表到 Cap 契约的映射（TS 纯函数）

这是整个 STT 改造的核心，也是最容易出错的一处。`apps/web/lib/edit-transcript.ts:69-82` 的 `AssemblyAIEditResult` 所有字段都是 `unknown` 且可选——它本质是个**防御式结构类型**，不绑定 AssemblyAI。因此只要构造出同形状的对象，`createEditTranscript` 就能原样复用，**无需改动任何类型定义**。

**Files:**
- Create: `apps/web/lib/whisper.ts`
- Test: `apps/web/__tests__/unit/whisper.test.ts`

**Interfaces:**
- Consumes: `AssemblyAIEditResult` from `@/lib/edit-transcript`
- Produces:
  - `type WhisperWord = { text: string; start: number; end: number; confidence: number | null }`
  - `type WhisperResult = { language: string | null; model: string; durationSeconds: number; words: WhisperWord[] }`
  - `parseWhisperResult(raw: unknown): WhisperResult`（校验 S3 上的 JSON）
  - `whisperResultToEditResult(result: WhisperResult): AssemblyAIEditResult`（**秒 → 毫秒**）
  - `isWhisperConfigured(): boolean`

- [ ] **Step 1: 写失败测试**

`apps/web/__tests__/unit/whisper.test.ts`：

```typescript
import { describe, expect, it, vi } from "vitest";

const serverEnvMock = vi.hoisted(() =>
	vi.fn<() => Record<string, string | undefined>>(() => ({})),
);

vi.mock("@cap/env", () => ({
	serverEnv: serverEnvMock,
	buildEnv: {},
}));

import {
	isWhisperConfigured,
	parseWhisperResult,
	whisperResultToEditResult,
} from "@/lib/whisper";

describe("whisperResultToEditResult", () => {
	it("把秒换算成毫秒", () => {
		const result = whisperResultToEditResult({
			language: "zh",
			model: "medium",
			durationSeconds: 2,
			words: [{ text: "你好", start: 1.2, end: 1.45, confidence: 0.93 }],
		});

		expect(result.words).toEqual([
			{
				text: "你好",
				start: 1200,
				end: 1450,
				confidence: 0.93,
				speaker: null,
				channel: null,
			},
		]);
	});

	it("毫秒取整，避免下游 clampMilliseconds 处产生小数", () => {
		const result = whisperResultToEditResult({
			language: null,
			model: "medium",
			durationSeconds: 1,
			words: [{ text: "hi", start: 0.1234, end: 0.5678, confidence: null }],
		});

		expect(result.words?.[0]?.start).toBe(123);
		expect(result.words?.[0]?.end).toBe(568);
	});

	it("speaker 与 channel 恒为 null（Whisper 不做说话人分离，契约允许）", () => {
		const result = whisperResultToEditResult({
			language: "en",
			model: "medium",
			durationSeconds: 1,
			words: [{ text: "a", start: 0, end: 0.1, confidence: 0.5 }],
		});

		expect(result.words?.[0]?.speaker).toBeNull();
		expect(result.words?.[0]?.channel).toBeNull();
	});

	it("透传 language_code 与 speech_model_used", () => {
		const result = whisperResultToEditResult({
			language: "zh",
			model: "medium",
			durationSeconds: 1,
			words: [],
		});

		expect(result.language_code).toBe("zh");
		expect(result.speech_model_used).toBe("whisper-medium");
	});

	it("空词表不报错", () => {
		expect(
			whisperResultToEditResult({
				language: null,
				model: "medium",
				durationSeconds: 0,
				words: [],
			}).words,
		).toEqual([]);
	});
});

describe("parseWhisperResult", () => {
	it("接受服务产出的形状", () => {
		const parsed = parseWhisperResult({
			language: "zh",
			model: "medium",
			durationSeconds: 12.5,
			words: [{ text: "hi", start: 0, end: 0.2, confidence: 0.9 }],
		});

		expect(parsed.words).toHaveLength(1);
		expect(parsed.durationSeconds).toBe(12.5);
	});

	it("丢弃时间戳非法的词而不是整体失败", () => {
		const parsed = parseWhisperResult({
			language: "zh",
			model: "medium",
			durationSeconds: 1,
			words: [
				{ text: "ok", start: 0, end: 0.2, confidence: 0.9 },
				{ text: "bad", start: "x", end: null, confidence: 0.9 },
			],
		});

		expect(parsed.words).toHaveLength(1);
		expect(parsed.words[0]?.text).toBe("ok");
	});

	it("形状完全不对时抛错", () => {
		expect(() => parseWhisperResult({ nope: true })).toThrow();
	});
});

describe("isWhisperConfigured", () => {
	it("四个变量齐全才算配置好", () => {
		serverEnvMock.mockReturnValue({
			WHISPER_CLUSTER_ARN: "arn:cluster",
			WHISPER_TASK_DEFINITION_ARN: "arn:taskdef",
			WHISPER_SUBNET_IDS: "subnet-1,subnet-2",
			WHISPER_SECURITY_GROUP_ID: "sg-1",
		});
		expect(isWhisperConfigured()).toBe(true);
	});

	it("缺一个就算未配置", () => {
		serverEnvMock.mockReturnValue({
			WHISPER_CLUSTER_ARN: "arn:cluster",
			WHISPER_TASK_DEFINITION_ARN: "arn:taskdef",
			WHISPER_SUBNET_IDS: "subnet-1",
		});
		expect(isWhisperConfigured()).toBe(false);
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/web && pnpm exec vitest run __tests__/unit/whisper.test.ts`
Expected: FAIL — 无法解析 `@/lib/whisper`

- [ ] **Step 3: 实现映射与配置判断**

`apps/web/lib/whisper.ts`（本 step 只写纯函数部分，RunTask 编排在 Task 16 追加到同一文件）：

```typescript
import { serverEnv } from "@cap/env";
import type { AssemblyAIEditResult } from "@/lib/edit-transcript";

export type WhisperWord = {
	text: string;
	start: number;
	end: number;
	confidence: number | null;
};

export type WhisperResult = {
	language: string | null;
	model: string;
	durationSeconds: number;
	words: WhisperWord[];
};

const finite = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

export function parseWhisperResult(raw: unknown): WhisperResult {
	if (typeof raw !== "object" || raw === null || !("words" in raw)) {
		throw new Error("Whisper result is not an object with a words array");
	}

	const record = raw as Record<string, unknown>;
	if (!Array.isArray(record.words)) {
		throw new Error("Whisper result words is not an array");
	}

	const words: WhisperWord[] = [];
	for (const entry of record.words) {
		if (typeof entry !== "object" || entry === null) continue;
		const word = entry as Record<string, unknown>;
		const text = typeof word.text === "string" ? word.text.trim() : "";
		const start = finite(word.start);
		const end = finite(word.end);
		if (!text || start === null || end === null) continue;
		words.push({ text, start, end, confidence: finite(word.confidence) });
	}

	return {
		language: typeof record.language === "string" ? record.language : null,
		model: typeof record.model === "string" ? record.model : "unknown",
		durationSeconds: finite(record.durationSeconds) ?? 0,
		words,
	};
}

/**
 * Whisper reports seconds; AssemblyAI — and therefore createEditTranscript —
 * expects milliseconds. Getting this wrong puts the whole timeline three
 * orders of magnitude out, so it lives here behind a unit test.
 */
export function whisperResultToEditResult(
	result: WhisperResult,
): AssemblyAIEditResult {
	return {
		language_code: result.language,
		speech_model_used: `whisper-${result.model}`,
		words: result.words.map((word) => ({
			text: word.text,
			start: Math.round(word.start * 1000),
			end: Math.round(word.end * 1000),
			confidence: word.confidence,
			speaker: null,
			channel: null,
		})),
	};
}

export function isWhisperConfigured(): boolean {
	const env = serverEnv();
	return Boolean(
		env.WHISPER_CLUSTER_ARN &&
			env.WHISPER_TASK_DEFINITION_ARN &&
			env.WHISPER_SUBNET_IDS &&
			env.WHISPER_SECURITY_GROUP_ID,
	);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/web && pnpm exec vitest run __tests__/unit/whisper.test.ts`
Expected: 10 个 PASS

- [ ] **Step 5: 格式化并提交**

```bash
cd /home/ec2-user/research/cap
pnpm exec biome check --write apps/web/lib/whisper.ts apps/web/__tests__/unit/whisper.test.ts
git add apps/web/lib/whisper.ts apps/web/__tests__/unit/whisper.test.ts
git commit -m "feat(web): map Whisper word timestamps onto the edit-transcript contract"
```

---

## Task 16: RunTask 编排与结果轮询

拆成两个函数而不是一个大函数：ECS 调用和轮询循环各自可独立测试，轮询逻辑用假的读取函数就能覆盖全部分支，不需要碰 AWS SDK。

**Files:**
- Modify: `apps/web/lib/whisper.ts`（追加）
- Modify: `apps/web/package.json`（加 `@aws-sdk/client-ecs`）
- Test: `apps/web/__tests__/unit/whisper.test.ts`（追加）

**Interfaces:**
- Consumes: Task 15 的 `parseWhisperResult`、`isWhisperConfigured`
- Produces:
  - `startWhisperTask(params: { bucket: string; inputKey: string; outputKey: string; language: string }): Promise<string>` 返回 task ARN
  - `pollWhisperOutput(readOutput: () => Promise<string | null>, options?: { attempts?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<WhisperResult>`
  - `whisperOutputKey(userId: string, videoId: string): string`

- [ ] **Step 1: 加依赖**

```bash
cd apps/web && pnpm add @aws-sdk/client-ecs
```

Expected: `package.json` 出现该依赖。版本跟随仓库既有的 `@aws-sdk/*` 主版本（`@aws-sdk/client-s3` 已在用）

- [ ] **Step 2: 追加失败测试**

在 `apps/web/__tests__/unit/whisper.test.ts` 末尾追加，并把顶部 import 补上 `pollWhisperOutput`、`whisperOutputKey`：

```typescript
describe("whisperOutputKey", () => {
	it("与音频对象同前缀，便于生命周期清理", () => {
		expect(whisperOutputKey("user-1", "video-1")).toBe(
			"user-1/video-1/whisper.words.json",
		);
	});
});

describe("pollWhisperOutput", () => {
	const noSleep = async () => {};

	it("对象一出现就解析并返回", async () => {
		const payload = JSON.stringify({
			language: "zh",
			model: "medium",
			durationSeconds: 1,
			words: [{ text: "hi", start: 0, end: 0.2, confidence: 0.9 }],
		});
		let calls = 0;
		const readOutput = async () => {
			calls += 1;
			return calls < 3 ? null : payload;
		};

		const result = await pollWhisperOutput(readOutput, {
			attempts: 10,
			intervalMs: 0,
			sleep: noSleep,
		});

		expect(result.words).toHaveLength(1);
		expect(calls).toBe(3);
	});

	it("超过尝试次数仍无结果则抛错", async () => {
		await expect(
			pollWhisperOutput(async () => null, {
				attempts: 3,
				intervalMs: 0,
				sleep: noSleep,
			}),
		).rejects.toThrow(/did not produce/i);
	});

	it("读取抛错时继续重试而不是立刻放弃", async () => {
		let calls = 0;
		const readOutput = async () => {
			calls += 1;
			if (calls === 1) throw new Error("transient s3 error");
			return JSON.stringify({
				language: null,
				model: "medium",
				durationSeconds: 0,
				words: [],
			});
		};

		const result = await pollWhisperOutput(readOutput, {
			attempts: 5,
			intervalMs: 0,
			sleep: noSleep,
		});

		expect(result.words).toEqual([]);
		expect(calls).toBe(2);
	});
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd apps/web && pnpm exec vitest run __tests__/unit/whisper.test.ts`
Expected: FAIL — `pollWhisperOutput` 不是函数

- [ ] **Step 4: 实现**

追加到 `apps/web/lib/whisper.ts`：

```typescript
import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";

const DEFAULT_POLL_ATTEMPTS = 120;
const DEFAULT_POLL_INTERVAL_MS = 5000;

export function whisperOutputKey(userId: string, videoId: string): string {
	return `${userId}/${videoId}/whisper.words.json`;
}

export async function startWhisperTask(params: {
	bucket: string;
	inputKey: string;
	outputKey: string;
	language: string;
}): Promise<string> {
	const env = serverEnv();
	const client = new ECSClient({ region: env.CAP_AWS_REGION });

	const response = await client.send(
		new RunTaskCommand({
			cluster: env.WHISPER_CLUSTER_ARN,
			taskDefinition: env.WHISPER_TASK_DEFINITION_ARN,
			launchType: "FARGATE",
			networkConfiguration: {
				awsvpcConfiguration: {
					subnets: (env.WHISPER_SUBNET_IDS ?? "").split(",").filter(Boolean),
					securityGroups: [env.WHISPER_SECURITY_GROUP_ID ?? ""],
					assignPublicIp: "DISABLED",
				},
			},
			overrides: {
				containerOverrides: [
					{
						name: "whisper",
						environment: [
							{ name: "INPUT_BUCKET", value: params.bucket },
							{ name: "INPUT_KEY", value: params.inputKey },
							{ name: "OUTPUT_KEY", value: params.outputKey },
							{ name: "LANGUAGE", value: params.language },
						],
					},
				],
			},
		}),
	);

	const failure = response.failures?.[0];
	if (failure) {
		throw new Error(
			`Failed to start whisper task: ${failure.reason ?? "unknown"} ${failure.detail ?? ""}`.trim(),
		);
	}

	const taskArn = response.tasks?.[0]?.taskArn;
	if (!taskArn) throw new Error("RunTask returned no task ARN");
	return taskArn;
}

const wait = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

export async function pollWhisperOutput(
	readOutput: () => Promise<string | null>,
	options?: {
		attempts?: number;
		intervalMs?: number;
		sleep?: (ms: number) => Promise<void>;
	},
): Promise<WhisperResult> {
	const attempts = options?.attempts ?? DEFAULT_POLL_ATTEMPTS;
	const intervalMs = options?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const sleep = options?.sleep ?? wait;

	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			const body = await readOutput();
			if (body) return parseWhisperResult(JSON.parse(body));
		} catch (error) {
			// A missing object and a transient S3 error look the same from here;
			// both are worth another attempt within the overall budget.
			console.warn("[whisper] poll attempt failed", error);
		}
		await sleep(intervalMs);
	}

	throw new Error(
		`Whisper task did not produce output after ${attempts} attempts`,
	);
}
```

默认预算 120 次 × 5 秒 = 10 分钟。`medium` int8 约 2–3 倍实时，覆盖约 3–5 分钟的视频；更长的视频要调大 `attempts`，或改用 Task 18 备注里的 GPU 方案。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd apps/web && pnpm exec vitest run __tests__/unit/whisper.test.ts`
Expected: 14 个 PASS

- [ ] **Step 6: 格式化并提交**

```bash
cd /home/ec2-user/research/cap
pnpm exec biome check --write apps/web/lib/whisper.ts apps/web/__tests__/unit/whisper.test.ts apps/web/package.json
git add apps/web/lib/whisper.ts apps/web/__tests__/unit/whisper.test.ts apps/web/package.json pnpm-lock.yaml
git commit -m "feat(web): add whisper RunTask orchestration and output polling"
```

---

## Task 17: 把 Whisper 接进 transcribe workflow

**这是全计划冲突风险最高的一处改动**（`transcribe.ts` 是上游活跃文件）。策略：**不删任何 AssemblyAI 代码**，只加分支，所有实质逻辑都在 `lib/whisper.ts` 里，让这个文件的 diff 尽量薄。

**动手前先重新定位行号**——本计划记录的行号可能已漂移：

```bash
cd /home/ec2-user/research/cap
grep -n "ASSEMBLY_API_KEY\|transcribeWithAssemblyAI\|transcribeEditTranscriptWithAssemblyAI" apps/web/workflows/transcribe.ts
```

**Files:**
- Modify: `apps/web/workflows/transcribe.ts`（四处接入 + 两个新函数）

**Interfaces:**
- Consumes: Task 15/16 的 `isWhisperConfigured`、`startWhisperTask`、`pollWhisperOutput`、`whisperOutputKey`、`whisperResultToEditResult`
- Produces: 无新导出；`transcribeVideoWorkflow` 在 Whisper 配置存在时走 Whisper

**已知限制（刻意接受并记录）**：Whisper 任务的 IAM 角色只能访问我们自己的桶，所以用户自配 S3 桶里的视频不会走 Whisper。我们的实例上没人配自定义桶（`userIsPro()` 虽为 true 但功能无人使用），因此可接受。

- [ ] **Step 1: 放宽两处配置守卫**

`validateVideo` 与 `validateEditTranscriptBackfill` 里各有一处：

```typescript
	if (!serverEnv().ASSEMBLY_API_KEY) {
		throw new FatalError("Missing ASSEMBLY_API_KEY");
	}
```

两处都改为：

```typescript
	if (!isWhisperConfigured() && !serverEnv().ASSEMBLY_API_KEY) {
		throw new FatalError("No transcription backend configured");
	}
```

顶部 import 加：

```typescript
import {
	isWhisperConfigured,
	pollWhisperOutput,
	startWhisperTask,
	whisperOutputKey,
	whisperResultToEditResult,
} from "@/lib/whisper";
```

- [ ] **Step 2: 加 Whisper 转写步骤**

在 `transcribeWithAssemblyAI` 函数**之前**插入。两个函数都标 `"use step"`，与现有 AssemblyAI 步骤保持一致。

```typescript
async function transcribeWithWhisper(
	userId: string,
	videoId: string,
	video: typeof videos.$inferSelect,
	audioFilename: string,
	language: AiGenerationLanguage,
	videoDurationMs: number,
): Promise<TranscriptionArtifacts> {
	"use step";

	const bucketName = serverEnv().CAP_AWS_BUCKET;
	const inputKey = `${userId}/${videoId}/${audioFilename}`;
	const outputKey = whisperOutputKey(userId, videoId);

	await startWhisperTask({
		bucket: bucketName,
		inputKey,
		outputKey,
		language,
	});

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);

	const result = await pollWhisperOutput(async () => {
		const object = await bucket.getObject(outputKey).pipe(runWorkflowPromise);
		if (!object) return null;
		return typeof object === "string" ? object : object.toString("utf-8");
	});

	const durationMs =
		videoDurationMs > 0 ? videoDurationMs : result.durationSeconds * 1000;
	const editTranscript = createEditTranscript(
		whisperResultToEditResult(result),
		durationMs,
	);

	return {
		vtt: editTranscriptWordsToCaptionVtt(editTranscript.words),
		editTranscript: serializeEditTranscript(editTranscript),
	};
}
```

`bucket.getObject` 的实际返回类型以本文件里现有用法为准（`saveTranscription` 用了 `bucket.putObject`；`generate-ai.ts:188` 用了 `bucket.getObject`）。若签名不同，按实际类型调整那三行读取逻辑——**不要为此改动 `Storage` 层**。

- [ ] **Step 3: 加 Whisper 的 edit-transcript 回填步骤**

紧接上一个函数之后：

```typescript
async function transcribeEditTranscriptWithWhisper(
	userId: string,
	videoId: string,
	video: typeof videos.$inferSelect,
	audioFilename: string,
	videoDurationSeconds: number,
): Promise<string> {
	"use step";

	const artifacts = await transcribeWithWhisper(
		userId,
		videoId,
		video,
		audioFilename,
		"auto",
		videoDurationSeconds * 1000,
	);
	return artifacts.editTranscript;
}
```

- [ ] **Step 4: 在两处调用点分流**

主流程（原先直接调 `transcribeWithAssemblyAI` 那处）改为：

```typescript
		const transcription = isWhisperConfigured()
			? await transcribeWithWhisper(
					userId,
					videoId,
					videoData.video,
					TEMP_AUDIO_FILENAME,
					videoData.aiGenerationLanguage,
					videoDurationMs,
				)
			: await transcribeWithAssemblyAI(
					audioUrl,
					videoData.aiGenerationLanguage,
					videoDurationMs,
				);
```

`TEMP_AUDIO_FILENAME` 用本文件里已有的那个常量名——`grep -n "tempAudioFilename\|TEMP_AUDIO_FILENAME\|EDIT_TRANSCRIPT_TEMP_AUDIO_FILENAME" apps/web/workflows/transcribe.ts` 确认实际名称后替换。

回填流程那处改为：

```typescript
		const editTranscript = isWhisperConfigured()
			? await transcribeEditTranscriptWithWhisper(
					userId,
					videoId,
					video,
					EDIT_TRANSCRIPT_TEMP_AUDIO_FILENAME,
					videoEdit ? videoEdit.editSpec.sourceDuration : (video.duration ?? 0),
				)
			: await transcribeEditTranscriptWithAssemblyAI(
					audioUrl,
					videoEdit ? videoEdit.editSpec.sourceDuration : (video.duration ?? 0),
				);
```

- [ ] **Step 5: 类型检查与全量单测**

```bash
cd /home/ec2-user/research/cap
pnpm exec tsc -b apps/web
cd apps/web && pnpm exec vitest run __tests__/unit
```

Expected: 类型无错误；单测全绿。若既有的 transcribe 相关测试因守卫文案改动而失败（`"Missing ASSEMBLY_API_KEY"` → `"No transcription backend configured"`），更新那些测试的断言

- [ ] **Step 6: 格式化并提交**

```bash
cd /home/ec2-user/research/cap
pnpm exec biome check --write apps/web/workflows/transcribe.ts
git add apps/web/workflows/transcribe.ts
git commit -m "feat(web): transcribe via self-hosted Whisper when configured

Keeps the AssemblyAI path intact and branches on configuration, so the diff
against upstream stays small in this frequently-changed file."
```

---

## Task 18: Whisper task definition（CDK）与端到端字幕验证

**Files:**
- Create: `infra-aws/lib/whisper.ts`
- Modify: `infra-aws/lib/compute.ts`（Task Role 加 `ecs:RunTask`；cap-web 加 `WHISPER_*` env）
- Modify: `infra-aws/lib/cap-stack.ts`
- Modify: `infra-aws/scripts/build-images.sh`（加 whisper 镜像）
- Test: `infra-aws/test/whisper.test.ts`

**Interfaces:**
- Consumes: `Compute.cluster` / `taskRole`、`Storage.bucket`、`Registry.whisper`、`Network.vpc`
- Produces: `class WhisperTask extends Construct`，暴露 `readonly taskDefinition: ecs.FargateTaskDefinition`、`readonly securityGroup: ec2.SecurityGroup`

**顺序上的注意**：`WhisperTask` 需要 `Compute.cluster`，而 `Compute` 的 cap-web 又需要 whisper 的 ARN 做 env。这不是环——ARN 可以在 `WhisperTask` 建好后通过 `webService.taskDefinition` 之外的途径注入吗？不能。**解法**：把 `WHISPER_*` 四个 env 从 `environment` 改为在 `cap-stack.ts` 里用 `taskDefinition.defaultContainer?.addEnvironment()` 在 `WhisperTask` 构造完成后追加。CDK 支持这种后置追加，不产生循环引用。

- [ ] **Step 1: 写失败测试**

`infra-aws/test/whisper.test.ts`：

```typescript
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { CapStack } from "../lib/cap-stack.js";
import { CONFIG } from "../lib/config.js";

let template: Template;

beforeAll(() => {
	process.env.CAP_CLOUDFRONT_PUBLIC_KEY = [
		"-----BEGIN PUBLIC KEY-----",
		"MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtest",
		"-----END PUBLIC KEY-----",
	].join("\n");

	const app = new cdk.App();
	const stack = new CapStack(app, "TestStack", {
		env: { account: "123456789012", region: CONFIG.region },
	});
	template = Template.fromStack(stack);
});

describe("WhisperTask", () => {
	it("建第三个 task definition，但不建第三个 service（按需 RunTask）", () => {
		template.resourceCountIs("AWS::ECS::TaskDefinition", 3);
		template.resourceCountIs("AWS::ECS::Service", 2);
	});

	it("规格为 4 vCPU / 8 GB", () => {
		template.hasResourceProperties("AWS::ECS::TaskDefinition", {
			Cpu: "4096",
			Memory: "8192",
		});
	});

	it("容器名必须是 whisper（RunTask 的 containerOverrides 按名字匹配）", () => {
		const json = JSON.stringify(
			Object.values(template.findResources("AWS::ECS::TaskDefinition")),
		);
		expect(json).toContain('"Name":"whisper"');
	});

	it("cap-web 的 Task Role 能 RunTask 并 PassRole", () => {
		const json = JSON.stringify(
			Object.values(template.findResources("AWS::IAM::Policy")),
		);
		expect(json).toContain("ecs:RunTask");
		expect(json).toContain("iam:PassRole");
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd infra-aws && pnpm test test/whisper.test.ts`
Expected: FAIL — 期望 3 个 task definition，找到 2 个

- [ ] **Step 3: 实现 WhisperTask**

`infra-aws/lib/whisper.ts`：

```typescript
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { CONFIG } from "./config.js";

export interface WhisperTaskProps {
	readonly vpc: ec2.Vpc;
	readonly bucket: s3.Bucket;
	readonly repository: ecr.Repository;
	/** cap-web 的 Task Role，需要被授予 RunTask/PassRole */
	readonly callerRole: iam.Role;
}

export class WhisperTask extends Construct {
	readonly taskDefinition: ecs.FargateTaskDefinition;
	readonly securityGroup: ec2.SecurityGroup;

	constructor(scope: Construct, id: string, props: WhisperTaskProps) {
		super(scope, id);

		this.securityGroup = new ec2.SecurityGroup(this, "Sg", {
			vpc: props.vpc,
			description: "On-demand whisper task; egress only",
			allowAllOutbound: true,
		});

		this.taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDef", {
			cpu: 4096,
			memoryLimitMiB: 8192,
		});

		props.bucket.grantReadWrite(this.taskDefinition.taskRole);

		// The container name is part of the contract: startWhisperTask sends
		// containerOverrides keyed by this exact name.
		this.taskDefinition.addContainer("whisper", {
			image: ecs.ContainerImage.fromEcrRepository(props.repository, "latest"),
			logging: ecs.LogDrivers.awsLogs({
				streamPrefix: "cap-whisper",
				logRetention: logs.RetentionDays.ONE_MONTH,
			}),
			environment: { WHISPER_MODEL: CONFIG.whisperModel },
		});

		props.callerRole.addToPolicy(
			new iam.PolicyStatement({
				actions: ["ecs:RunTask"],
				resources: [this.taskDefinition.taskDefinitionArn],
			}),
		);
		props.callerRole.addToPolicy(
			new iam.PolicyStatement({
				actions: ["iam:PassRole"],
				resources: [
					this.taskDefinition.taskRole.roleArn,
					this.taskDefinition.executionRole?.roleArn ?? "*",
				],
				conditions: {
					StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" },
				},
			}),
		);
		void cdk;
	}
}
```

若 `void cdk;` 触发 lint，直接删掉那行与 `cdk` 的 import。

- [ ] **Step 4: 接入 stack 并后置注入 env**

在 `cap-stack.ts` 里，`Compute` 之后：

```typescript
		const compute = new Compute(this, "Compute", { /* 同 Task 7/9 */ });

		const whisper = new WhisperTask(this, "Whisper", {
			vpc: network.vpc,
			bucket: storage.bucket,
			repository: registry.whisper,
			callerRole: compute.taskRole,
		});

		// 后置追加，避免 Compute ↔ WhisperTask 的循环引用
		const webContainer = compute.webService.taskDefinition.defaultContainer;
		webContainer?.addEnvironment(
			"WHISPER_CLUSTER_ARN",
			compute.cluster.clusterArn,
		);
		webContainer?.addEnvironment(
			"WHISPER_TASK_DEFINITION_ARN",
			whisper.taskDefinition.taskDefinitionArn,
		);
		webContainer?.addEnvironment(
			"WHISPER_SUBNET_IDS",
			network.vpc.privateSubnets.map((s) => s.subnetId).join(","),
		);
		webContainer?.addEnvironment(
			"WHISPER_SECURITY_GROUP_ID",
			whisper.securityGroup.securityGroupId,
		);
```

顶部加 `import { WhisperTask } from "./whisper.js";`

- [ ] **Step 5: 构建脚本加 whisper 镜像**

在 `infra-aws/scripts/build-images.sh` 的 media-server 之后加（并把参数扩到第 5 个 `<whisper-repo>`，`WHISPER_REPO="${5:?whisper repo name required}"`）：

```bash
echo "--- building whisper"
docker build \
	-f "${REPO_ROOT}/apps/whisper-server/Dockerfile" \
	-t "${REGISTRY}/${WHISPER_REPO}:latest" \
	"${REPO_ROOT}/apps/whisper-server"
docker push "${REGISTRY}/${WHISPER_REPO}:latest"
```

- [ ] **Step 6: 运行全部 CDK 测试**

```bash
cd infra-aws
export CAP_CLOUDFRONT_PUBLIC_KEY="$(cat ~/.cap-cf-public-key.pem)"
pnpm test
```

Expected: whisper 4 个 PASS，之前全部仍 PASS

- [ ] **Step 7: 部署并验证字幕**

```bash
cd infra-aws && pnpm exec cdk deploy --require-approval never --outputs-file outputs.json
cd /home/ec2-user/research/cap
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
APP_URL=$(jq -r .CapStack.AppUrl infra-aws/outputs.json)
WEB_REPO=$(jq -r .CapStack.WebRepositoryUri infra-aws/outputs.json | cut -d/ -f2-)
MEDIA_REPO=$(jq -r .CapStack.MediaServerRepositoryUri infra-aws/outputs.json | cut -d/ -f2-)
WHISPER_REPO=$(jq -r .CapStack.WhisperRepositoryUri infra-aws/outputs.json | cut -d/ -f2-)
./infra-aws/scripts/build-images.sh "$ACCOUNT" "$WEB_REPO" "$MEDIA_REPO" "$APP_URL" "$WHISPER_REPO"
```

再 `--force-new-deployment` 并等 stable，然后录一段**中文**视频。

Expected: 几分钟后字幕出现，中文准确度可接受。排查路径：
- `aws ecs list-tasks --cluster <cluster> --desired-status STOPPED` 看 whisper 任务是否起来过
- whisper 任务的 CloudWatch 日志（stream prefix `cap-whisper`）
- cap-web 日志里的 `[whisper] poll attempt failed`
- 桶里是否出现 `<userId>/<videoId>/whisper.words.json`

若中文质量不达预期，把 `CONFIG.whisperModel` 改成 `large-v3` 并把任务规格提到 8 vCPU / 16 GB（重建镜像）；仍不够则转 SageMaker GPU（spec §9.3）。

- [ ] **Step 8: 格式化并提交**

```bash
cd /home/ec2-user/research/cap
pnpm exec biome check --write infra-aws
git add infra-aws
git commit -m "feat(infra-aws): add on-demand whisper task and grant RunTask to cap-web"
```

---

## Task 19: Bedrock LLM provider

`apps/web/lib/ai/provider.ts` 的几个 switch 都是无 `default` 的穷尽匹配，所以**只要给 `AiProviderId` union 加上 `"bedrock"`，TypeScript 就会把剩下四处该改的地方逐个报出来**。照编译错误走一遍即可，不必凭记忆找。

`DEFAULT_MODELS` 的类型是 `Record<Exclude<AiProviderId, "openai-compatible">, ...>`，同理会强制要求补齐条目。

**Files:**
- Modify: `apps/web/lib/ai/provider.ts`（五处）
- Modify: `apps/web/package.json`（加 `@ai-sdk/amazon-bedrock`）
- Test: `apps/web/__tests__/unit/ai-provider.test.ts`（追加）

**Interfaces:**
- Consumes: Task 10 的 `BEDROCK_REGION` 与 `AI_PROVIDER` union
- Produces: `AI_PROVIDER=bedrock` 时 `getAiModel(role)` 返回 Bedrock 模型

- [ ] **Step 1: 加依赖**

```bash
cd apps/web && pnpm add @ai-sdk/amazon-bedrock
```

- [ ] **Step 2: 追加失败测试**

在 `apps/web/__tests__/unit/ai-provider.test.ts` 末尾追加：

```typescript
describe("bedrock provider", () => {
	it("显式选中且 BEDROCK_REGION 存在时可用", () => {
		envWith({ AI_PROVIDER: "bedrock", BEDROCK_REGION: "us-east-1" });

		expect(getConfiguredAiProviders()).toEqual(["bedrock"]);
		expect(isAiConfigured()).toBe(true);
	});

	it("绝不被自动探测选中（避免无意产生 Bedrock 费用）", () => {
		envWith({ BEDROCK_REGION: "us-east-1" });

		expect(getConfiguredAiProviders()).toEqual([]);
		expect(getConfiguredAiProviders("chat")).toEqual([]);
	});

	it("缺 BEDROCK_REGION 时即使显式选中也不可用", () => {
		envWith({ AI_PROVIDER: "bedrock" });

		expect(getConfiguredAiProviders()).toEqual([]);
	});

	it("三个 role 都有默认模型", () => {
		envWith({ AI_PROVIDER: "bedrock", BEDROCK_REGION: "us-east-1" });

		for (const role of ["generation", "chat", "chat-streaming"] as const) {
			const selection = getAiModel(role);
			expect(selection?.provider).toBe("bedrock");
			expect(selection?.modelId).toBeTruthy();
		}
	});
});
```

`getAiModel` 的实际签名与返回值以文件现有测试的用法为准；若它需要额外参数，按既有测试的调用方式对齐。

- [ ] **Step 3: 运行测试确认失败**

Run: `cd apps/web && pnpm exec vitest run __tests__/unit/ai-provider.test.ts`
Expected: FAIL — `getConfiguredAiProviders()` 返回 `[]` 而非 `["bedrock"]`

- [ ] **Step 4: 改动一：union**

`apps/web/lib/ai/provider.ts` 第 8–13 行：

```typescript
export type AiProviderId =
	| "assemblyai"
	| "openai"
	| "anthropic"
	| "groq"
	| "bedrock"
	| "openai-compatible";
```

- [ ] **Step 5: 改动二：DEFAULT_MODELS**

在 `anthropic` 条目之后加：

```typescript
	bedrock: {
		generation: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
		chat: "us.anthropic.claude-sonnet-5-20250929-v1:0",
		"chat-streaming": "us.anthropic.claude-sonnet-5-20250929-v1:0",
	},
```

**部署前用 `aws bedrock list-inference-profiles --region us-east-1` 核实这两个 id 存在且账号已开通访问**（见「跨阶段依赖」第 3 条）。id 写错的症状是单测全绿、实跑 `ValidationException` 或 `AccessDeniedException`。

- [ ] **Step 6: 改动三与四：isProviderConfigured 与 missingCredentialHint**

`isProviderConfigured` 的 switch 加：

```typescript
		case "bedrock":
			return Boolean(env.BEDROCK_REGION);
```

`missingCredentialHint` 的 switch 加：

```typescript
		case "bedrock":
			return "BEDROCK_REGION is not set";
```

- [ ] **Step 7: 改动五：createModel**

在 `createModel` 的 switch 里加（顶部 import 加 `import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";`）：

```typescript
		case "bedrock":
			// No API key: credentials resolve from the ECS task role via the
			// default AWS provider chain.
			return createAmazonBedrock({ region: env.BEDROCK_REGION })(modelId);
```

- [ ] **Step 8: AUTO_DETECT_ORDER 刻意不加 bedrock**

三条链都**不要**加 `"bedrock"`。理由与文件里 `assemblyai` 那段注释同源：Bedrock 必须显式 opt-in，否则一个只想自建转写的实例会在无意间开始产生 LLM 费用。在 `AUTO_DETECT_ORDER` 上方那段已有注释里补一句：

```typescript
// `assemblyai` and `bedrock` are intentionally absent: neither is ever
// auto-detected, so transcription-only instances don't silently start
// incurring LLM charges.
```

（把原有的 `` `assemblyai` is intentionally absent `` 那句替换掉，别叠加两段说同一件事。）

- [ ] **Step 9: 运行测试确认通过**

```bash
cd apps/web
pnpm exec vitest run __tests__/unit/ai-provider.test.ts
pnpm exec vitest run __tests__/unit
```

Expected: 新增 4 个 PASS，既有 ai-provider 测试全部仍 PASS（`AUTO_DETECT_ORDER` 没动，自动探测行为不变）

- [ ] **Step 10: 类型检查、格式化并提交**

```bash
cd /home/ec2-user/research/cap
pnpm exec tsc -b apps/web
pnpm exec biome check --write apps/web/lib/ai/provider.ts apps/web/__tests__/unit/ai-provider.test.ts apps/web/package.json
git add apps/web/lib/ai/provider.ts apps/web/__tests__/unit/ai-provider.test.ts apps/web/package.json pnpm-lock.yaml
git commit -m "feat(web): add Bedrock AI provider using the task role

Opt-in via BEDROCK_REGION and never auto-detected, matching how assemblyai
is kept out of the auto-detect chains."
```

---

## Task 20: 打开 AI 并做最终端到端验证

**Files:**
- Modify: `infra-aws/lib/compute.ts`（cap-web 加 `AI_PROVIDER` / `BEDROCK_REGION` env）
- Modify: `design/superpowers/specs/2026-08-17-cap-aws-selfhost-design.md`（更新未决问题）

**Interfaces:**
- Consumes: Task 1–19 全部产出
- Produces: 一个功能完整的自建 Cap

- [ ] **Step 1: 确认 Bedrock 模型访问已开通**

```bash
aws bedrock list-inference-profiles --region us-east-1 \
	--query 'inferenceProfileSummaries[].inferenceProfileId' --output table
```

Expected: 输出中包含 Task 19 Step 5 写入的两个 id。**不在其中就先去控制台开通模型访问**，否则后面全白跑

- [ ] **Step 2: 把 Bedrock 配置注入 cap-web**

`infra-aws/lib/compute.ts` 的 cap-web `environment` 加两项：

```typescript
				AI_PROVIDER: "bedrock",
				BEDROCK_REGION: cdk.Stack.of(this).region,
```

- [ ] **Step 3: 部署并重建镜像**

```bash
cd /home/ec2-user/research/cap
export CAP_CLOUDFRONT_PUBLIC_KEY="$(cat ~/.cap-cf-public-key.pem)"
cd infra-aws && pnpm test && pnpm exec cdk deploy --require-approval never --outputs-file outputs.json
```

再按 Task 18 Step 7 的方式重建三个镜像、`--force-new-deployment`、等 stable。

- [ ] **Step 4: 走完整验收清单**

逐项确认，任何一项失败都记录实际现象再排查：

1. **登录**：Cognito 按钮可见 → hosted UI → 回跳 dashboard
2. **浏览器录制上传播放**：能录、能看
3. **播放走签名 URL**：开发者工具里播放请求指向 Media distribution，URL 含 `Signature=` 与 `Key-Pair-Id=`
4. **桶零公开**：`aws s3api get-public-access-block` 四项全 true；匿名 `curl https://<bucket>.s3.amazonaws.com/` 返回 403
5. **分享链接**：形如 `https://dxxxx.cloudfront.net/s/<id>`，**不含 localhost**
6. **中文字幕**：录一段中文视频，几分钟后字幕出现且准确度可接受
7. **AI 摘要与章节**：字幕完成后自动生成，内容与视频相关
8. **桌面端**：设置 Cap Server URL → 登录 → 录制 → 上传 → 分享链接在 VPN 外可打开

- [ ] **Step 5: 确认已知缺失符合预期**

这些是 spec §2 明确列为非目标的，验收时**不应**当作 bug：

- 评论通知、分享通知、团队邀请**邮件不会发出**，且不报错（`packages/database/emails/config.ts:32` 静默 return）
- 音频增强功能不可用（未配 `REPLICATE_API_TOKEN`）
- 无自定义域名，用的是 `*.cloudfront.net`

- [ ] **Step 6: 更新 spec 的未决问题**

把 spec §15 里已经落定的三项未决问题改为结论：

- Bedrock 模型选型 → 填入实际使用的 inference profile id
- 是否需要 KMS CMK → 记录本次的决定与理由
- 视频生命周期策略 → 记录决定（若仍未定，保留为未决并写明触发条件，例如「桶超过 N TB 时再评估」）

同时把 Task 13 Step 8 与本 task Step 4 的实际结果整理进部署记录。

- [ ] **Step 7: 最终提交与推送**

```bash
cd /home/ec2-user/research/cap
pnpm exec biome check --write infra-aws
git add infra-aws design/
git commit -m "feat(infra-aws): enable Bedrock for cap-web and record final verification"
git push origin dev
```

- [ ] **Step 8: 确认 main 未被污染**

```bash
git log --oneline origin/main -1
git rev-parse origin/main upstream/main
```

Expected: 两个 SHA 相同——`main` 全程保持上游纯镜像。若不同，说明有提交误落到 `main`，需要处理

---

## 自查记录

按 writing-plans 的要求，写完后对照 spec 复查了三项：

**Spec 覆盖**：spec §5–§9 的每个要求都能指到对应 task（网络入口→Task 3、存储→Task 4、计算数据库→Task 5/7、Cognito→Task 9/11/12、Whisper→Task 14–18、Bedrock→Task 19、测试策略→各 task 的断言与单测、§14 六阶段→Task 1–20）。§2 的非目标在 Task 20 Step 5 显式复核，避免被当成缺陷。

**实施中发现并已修正的 spec 偏差**（这些是 spec 里没有、只有读代码才暴露的）：

1. **不能 mirror 上游镜像**。`apps/web/Dockerfile:14` 在构建前写死 `NEXT_PUBLIC_WEB_URL=http://localhost:3000`，而该变量构建期内联，会让所有分享链接指向 localhost。改为参数化自建（Task 6）
2. **Cognito 接入是 5 处不是 3 处**。spec §8 漏了 `apps/web/utils/public-env.tsx` 与 `apps/web/app/Layout/AppProviders.tsx`；更关键的是 `login/form.tsx:524` 的区块门控只认 google/workos，不改的话按钮永不渲染（Task 12）
3. **construct 有依赖环**。桶 CORS 需要 App CF 域名 → 需要 ALB → cap-web env 需要桶名。把 ALB 拆到 `frontdoor.ts` 解环（File Structure 一节）
4. **`DATABASE_URL` 不能在 CDK 里拼装**。任何走 CloudFormation 动态引用的拼装都会把明文密码落进 task definition。改为空壳 secret + 部署后一条 CLI 填入（Task 5）
5. **Bedrock 需要一个显式 opt-in env**。它没有 API key，`isProviderConfigured` 无从判断，且不能进自动探测链（Task 10 Step 2、Task 19 Step 8）
6. **`AssemblyAIEditResult` 是防御式结构类型**，字段全为 `unknown` 且可选，因此 Whisper 映射**无需改动任何类型定义**——比 spec §9.2 的估计更小（Task 15）

**占位符扫描**：无 TBD/TODO。三处刻意的「按实际情况核实」都给了具体的核实命令和失败症状——`transcribe.ts` 行号（Task 17 开头的 grep）、`bucket.getObject` 返回类型（Task 17 Step 2）、Bedrock 模型 id（Task 19 Step 5 + Task 20 Step 1）。这些是上游会漂移或需要账号状态确认的事实，不是未完成的设计。

**类型一致性**：`WhisperResult` / `WhisperWord` 在 Task 15 定义，Task 16、17 沿用同名字段（`durationSeconds`、`words[].start` 为秒）。Python 侧输出的 JSON 键与 `parseWhisperResult` 读取的键一致（`language` / `model` / `durationSeconds` / `words`）。容器名 `whisper` 在 Task 14（Dockerfile 无关）、Task 16（`containerOverrides.name`）、Task 18（`addContainer("whisper")`）三处一致——这是个静默失败点，RunTask 的 override 按名匹配，名字不符不会报错但环境变量不会生效。

**已知的断言值需要跟着变**：Task 9 会让 `database.test.ts` 里 `resourceCountIs("AWS::SecretsManager::Secret", 6)` 变成 7，Task 9 Step 5 已写明要改断言值而不是绕过。
