#!/usr/bin/env bash
# Deploy Cap to the AWS account in your current credentials: the first deploy
# and every update after it. Each step checks what is already there, so the
# script is safe to re-run. See infra-aws/DEPLOY.md.
#
# Usage: ./infra-aws/scripts/deploy.sh [options]
#   --admin-email EMAIL  create a Cognito user for EMAIL (prints its password once)
#   --with-whisper       rebuild the Whisper image (built automatically the first time)
#   --skip-images        deploy infrastructure only, keep the current images
#   --force              roll services even if a transcription is in flight
#   --plan               show what would happen, change nothing
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INFRA="$REPO_ROOT/infra-aws"
STACK=CapStack
REGION="$(sed -n 's/^[[:space:]]*region: "\([^"]*\)".*/\1/p' "$INFRA/lib/config.ts")"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"

ADMIN_EMAIL=""
WITH_WHISPER=false
SKIP_IMAGES=false
FORCE=false
PLAN=false
while [ $# -gt 0 ]; do
	case "$1" in
	--admin-email) ADMIN_EMAIL="${2:?--admin-email needs a value}"; shift ;;
	--with-whisper) WITH_WHISPER=true ;;
	--skip-images) SKIP_IMAGES=true ;;
	--force) FORCE=true ;;
	--plan) PLAN=true ;;
	-h | --help) sed -n '2,12p' "$0"; exit 0 ;;
	*) echo "unknown option: $1" >&2; exit 2 ;;
	esac
	shift
done

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() { printf '\n\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
plan_or() { if $PLAN; then note "[plan] would: $*"; return 1; fi; }

# --- preflight -------------------------------------------------------------
log "Checking tools and credentials"
for tool in aws docker bun node npx openssl python3 jq curl; do
	command -v "$tool" >/dev/null || die "$tool is not installed"
done
docker info >/dev/null 2>&1 || die "Docker is not running"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] || die "Node 24 or newer is required"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)" || die "no AWS credentials"
note "account $ACCOUNT, region $REGION"

STATE="${CAP_DEPLOY_STATE_DIR:-$HOME/.cap-deploy/$ACCOUNT}"
mkdir -p "$STATE" && chmod 700 "$STATE"
note "deploy state in $STATE (keep it: it holds the CloudFront signing key)"

for model in us.anthropic.claude-sonnet-5-5 us.anthropic.claude-opus-5-5; do
	if aws bedrock-runtime converse --model-id "$model" \
		--messages '[{"role":"user","content":[{"text":"ok"}]}]' \
		--inference-config '{"maxTokens":16}' >/dev/null 2>&1; then
		note "Bedrock $model: available"
	else
		note "WARNING: Bedrock $model is not available in this account; enable model access, or summaries and Q&A will fail"
	fi
done

# --- CloudFront signing key --------------------------------------------------
KEY="$STATE/cloudfront_private_key.pem"
PUB="$STATE/cloudfront_public_key.pem"
if [ ! -f "$KEY" ]; then
	log "Generating the CloudFront signing key"
	if plan_or "generate $KEY"; then
		(umask 077 && openssl genrsa -out "$KEY" 2048 2>/dev/null)
		openssl rsa -pubout -in "$KEY" -out "$PUB" 2>/dev/null
	fi
fi
[ -f "$PUB" ] || $PLAN || openssl rsa -pubout -in "$KEY" -out "$PUB" 2>/dev/null

cdk() {
	(cd "$INFRA" && CDK_DEFAULT_ACCOUNT="$ACCOUNT" CAP_CLOUDFRONT_PUBLIC_KEY="$(cat "$PUB")" \
		bunx cdk "$@" --output cdk.out.deploy)
}
stack_status() {
	aws cloudformation describe-stacks --stack-name "$1" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo MISSING
}
output() {
	aws cloudformation describe-stacks --stack-name "$STACK" \
		--query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
resource() {
	aws cloudformation describe-stack-resources --stack-name "$STACK" \
		--query "StackResources[?ResourceType=='$1'].PhysicalResourceId" --output text
}
deploy_stack() {
	cdk deploy "$STACK" --require-approval never --outputs-file outputs.json "$@"
	# cdk deploy can exit 0 without deploying (eg. a concurrent cdk.out reader),
	# so trust the stack status, not the exit code.
	case "$(stack_status "$STACK")" in
	*_COMPLETE) ;;
	*) die "stack is $(stack_status "$STACK") after deploy" ;;
	esac
}

log "Installing dependencies"
if plan_or "bun install --frozen-lockfile"; then
	if ! (cd "$REPO_ROOT" && bun install --frozen-lockfile >"$STATE/install.log" 2>&1); then
		tail -20 "$STATE/install.log" >&2
		die "bun install failed (full log: $STATE/install.log)"
	fi
fi

if [ "$(stack_status CDKToolkit)" = MISSING ]; then
	log "Bootstrapping CDK in $ACCOUNT/$REGION"
	if plan_or "cdk bootstrap"; then cdk bootstrap "aws://$ACCOUNT/$REGION"; fi
fi

# --- first deploy: empty services, so the stack can finish without images ----
FIRST_DEPLOY=false
if [ "$(stack_status "$STACK")" = MISSING ]; then
	FIRST_DEPLOY=true
	log "First deploy (services start with 0 tasks; images do not exist yet)"
	if plan_or "cdk deploy -c skipTasks=true"; then deploy_stack -c skipTasks=true; fi
	$PLAN && { note "[plan] the remaining steps need the stack; run without --plan"; exit 0; }
fi

APP_URL="$(output AppUrl)"
CLUSTER="$(resource AWS::ECS::Cluster)"
SERVICES="$(resource AWS::ECS::Service)"
note "app: $APP_URL"

# --- updates must not cut off work running inside cap-web --------------------
if ! $FIRST_DEPLOY && ! $FORCE; then
	whisper_family="$(aws ecs describe-task-definition --task-definition "$(resource AWS::ECS::TaskDefinition | tr '\t' '\n' | grep -i whisper | head -1)" \
		--query 'taskDefinition.family' --output text 2>/dev/null || true)"
	running=""
	[ -n "$whisper_family" ] && running="$(aws ecs list-tasks --cluster "$CLUSTER" --family "$whisper_family" --query 'taskArns' --output text)"
	transcribing="$(aws transcribe list-transcription-jobs --status IN_PROGRESS --job-name-contains cap- --query 'TranscriptionJobSummaries[].TranscriptionJobName' --output text)"
	if [ -n "$running$transcribing" ]; then
		die "a transcription or keyframe task is running; rolling cap-web now would strand it. Wait, or pass --force"
	fi
fi

# --- CloudFront VPC origin security group -----------------------------------
VPC="$(resource AWS::EC2::VPC)"
SG="$(aws ec2 describe-security-groups --filters Name=group-name,Values=CloudFront-VPCOrigins-Service-SG "Name=vpc-id,Values=$VPC" \
	--query 'SecurityGroups[0].GroupId' --output text)"
if [ -z "$SG" ] || [ "$SG" = None ]; then
	die "CloudFront has not created its VPC origin security group in $VPC yet; re-run in a few minutes"
fi
note "CloudFront VPC origin security group: $SG"

# --- secrets CDK cannot fill --------------------------------------------------
log "Checking secrets"
put_secret() {
	local arn="$1" value="$2" name="$3" current
	current="$(aws secretsmanager get-secret-value --secret-id "$arn" --query SecretString --output text 2>/dev/null || true)"
	if [ "$current" = "$value" ]; then note "$name: up to date"; return; fi
	if plan_or "write $name"; then
		aws secretsmanager put-secret-value --secret-id "$arn" --secret-string "$value" >/dev/null
		note "$name: written"
	fi
}
if [ -f "$KEY" ]; then
	put_secret "$(output CloudFrontPrivateKeySecretArn)" "$(cat "$KEY")" "CloudFront private key"
else
	note "[plan] would: write the CloudFront private key generated above"
fi

DATABASE_URL="$(aws secretsmanager get-secret-value --secret-id "$(output DatabaseCredentialsSecretArn)" --query SecretString --output text |
	python3 -c 'import json, sys, urllib.parse as u
c = json.load(sys.stdin)
user = u.quote(c["username"], safe="")
password = u.quote(c["password"], safe="")
print("mysql://%s:%s@%s:%s/cap?ssl=Amazon%%20RDS" % (user, password, c["host"], c.get("port", 3306)))')"
put_secret "$(output DatabaseUrlSecretArn)" "$DATABASE_URL" "DATABASE_URL"
unset DATABASE_URL

# --- images -------------------------------------------------------------------
BUILT_IMAGES=false
if ! $SKIP_IMAGES; then
	repo_name() { output "$1" | cut -d/ -f2; }
	WEB_REPO="$(repo_name WebRepositoryUri)"
	MEDIA_REPO="$(repo_name MediaServerRepositoryUri)"
	WHISPER_REPO="$(repo_name WhisperRepositoryUri)"
	if ! aws ecr describe-images --repository-name "$WHISPER_REPO" --image-ids imageTag=latest >/dev/null 2>&1; then
		WITH_WHISPER=true
	fi
	IMAGES="web, media-server"
	$WITH_WHISPER && IMAGES="$IMAGES, whisper (~2.6 GB, slow the first time)"
	log "Building and pushing images: $IMAGES"
	if plan_or "build $IMAGES for $APP_URL"; then
		BUILD_LOG="$STATE/build-images.log"
		note "log: $BUILD_LOG"
		# Redirected, not piped: a pipe would hide the script's exit status.
		WHISPER_ARG=""
		$WITH_WHISPER && WHISPER_ARG="$WHISPER_REPO"
		if ! "$INFRA/scripts/build-images.sh" "$ACCOUNT" "$WEB_REPO" "$MEDIA_REPO" "$APP_URL" \
			"$WHISPER_ARG" >"$BUILD_LOG" 2>&1; then
			tail -30 "$BUILD_LOG" >&2
			die "image build failed (full log: $BUILD_LOG)"
		fi
		BUILT_IMAGES=true
	fi
fi

# --- full deploy ----------------------------------------------------------------
log "Deploying the stack"
if plan_or "cdk deploy -c cfVpcOriginSgId=$SG"; then
	deploy_stack -c cfVpcOriginSgId="$SG"
fi

if $PLAN && ! $SKIP_IMAGES && ! $FIRST_DEPLOY; then
	note "[plan] would: roll services onto the new images"
fi
# Service Connect gives a deployment only the endpoints that exist when the
# deployment is created, so the deployments made with the services cannot all
# reach each other. Rolling both now, with both endpoints in place, makes
# cap-web -> media-server and the webhooks back resolve.
roll_services() {
	log "$1"
	for service in $SERVICES; do
		aws ecs update-service --cluster "$CLUSTER" --service "$service" --force-new-deployment >/dev/null
	done
}
if $FIRST_DEPLOY; then
	roll_services "Rolling services so Service Connect sees both endpoints"
elif $BUILT_IMAGES; then
	roll_services "Rolling services onto the new images"
fi
if ! $PLAN; then
	log "Waiting for services to become stable"
	# shellcheck disable=SC2086
	aws ecs wait services-stable --cluster "$CLUSTER" --services $SERVICES ||
		aws ecs wait services-stable --cluster "$CLUSTER" --services $SERVICES ||
		die "services did not stabilise; check the cap-web logs in CloudWatch"
fi

# --- first user -------------------------------------------------------------------
if [ -n "$ADMIN_EMAIL" ]; then
	POOL="$(output CognitoIssuer | sed 's#.*/##')"
	if aws cognito-idp admin-get-user --user-pool-id "$POOL" --username "$ADMIN_EMAIL" >/dev/null 2>&1; then
		note "Cognito user $ADMIN_EMAIL already exists"
	elif plan_or "create Cognito user $ADMIN_EMAIL"; then
		PASSWORD="$(python3 -c 'import secrets, string
pool = string.ascii_letters + string.digits
while True:
    p = "".join(secrets.choice(pool) for _ in range(20))
    if any(c.islower() for c in p) and any(c.isupper() for c in p) and any(c.isdigit() for c in p):
        print(p); break')"
		# email_verified=true is required: sign-in goes through the generic OIDC
		# provider, which refuses unverified emails.
		aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$ADMIN_EMAIL" \
			--user-attributes Name=email,Value="$ADMIN_EMAIL" Name=email_verified,Value=true \
			--message-action SUPPRESS >/dev/null
		aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username "$ADMIN_EMAIL" \
			--password "$PASSWORD" --permanent
		note "created $ADMIN_EMAIL with password: $PASSWORD   (shown once; change it after signing in)"
	fi
fi

if ! $PLAN; then
	status="$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL/login")"
	[ "$status" = 200 ] || die "$APP_URL/login answered $status"
fi
log "Done: $APP_URL"
$PLAN && note "(plan only; nothing was changed)"
exit 0
