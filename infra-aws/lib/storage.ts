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
				viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
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
