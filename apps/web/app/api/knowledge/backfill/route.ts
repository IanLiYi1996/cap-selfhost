import { db } from "@cap/database";
import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizationMembers, organizations } from "@cap/database/schema";
import type { Organisation, User } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { start } from "workflow/api";
import { knowledgeSession } from "@/lib/knowledge/session";
import { knowledgeBackfillWorkflow } from "@/workflows/knowledge-backfill";

export const dynamic = "force-dynamic";

async function canManageOrganization(
	userId: User.UserId,
	orgId: Organisation.OrganisationId,
) {
	const [org] = await db()
		.select({ ownerId: organizations.ownerId })
		.from(organizations)
		.where(eq(organizations.id, orgId))
		.limit(1);
	if (org?.ownerId === userId) return true;
	const [member] = await db()
		.select({ role: organizationMembers.role })
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, orgId),
				eq(organizationMembers.userId, userId),
			),
		)
		.limit(1);
	return member?.role === "owner" || member?.role === "admin";
}

export async function GET() {
	const session = await knowledgeSession(await getCurrentUser());
	if (!session.ok) return session.response;
	return Response.json({
		canBackfill: await canManageOrganization(session.user.id, session.orgId),
	});
}

/** Index the organization's existing meetings; for owners and admins. */
export async function POST(request: NextRequest) {
	const session = await knowledgeSession(
		isCrossSiteCookieWrite(request) ? null : await getCurrentUser(),
	);
	if (!session.ok) return session.response;
	if (!(await canManageOrganization(session.user.id, session.orgId))) {
		return Response.json(
			{ error: "Only organization owners and admins can do this." },
			{ status: 403 },
		);
	}
	await start(knowledgeBackfillWorkflow, [{ orgId: session.orgId }]);
	return Response.json({ started: true }, { status: 202 });
}
