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
