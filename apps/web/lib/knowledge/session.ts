import type { getCurrentUser } from "@cap/database/auth/session";
import { Storage } from "@cap/web-backend";
import type { Organisation } from "@cap/web-domain";
import { runPromise } from "@/lib/server";
import { isKnowledgeEnabled } from "./store";

type CurrentUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

export type KnowledgeSession =
	| { ok: true; user: CurrentUser; orgId: Organisation.OrganisationId }
	| { ok: false; response: Response };

/** The signed-in user and the organization whose meetings they search: their
 * active one, as on the dashboard. */
export async function knowledgeSession(
	user: CurrentUser | null,
): Promise<KnowledgeSession> {
	if (!isKnowledgeEnabled()) {
		return {
			ok: false,
			response: Response.json(
				{ error: "Knowledge search is not set up on this instance." },
				{ status: 503 },
			),
		};
	}
	if (!user) {
		return {
			ok: false,
			response: Response.json({ error: "Sign in first." }, { status: 401 }),
		};
	}
	const orgId = user.activeOrganizationId as Organisation.OrganisationId | null;
	if (!orgId) {
		return {
			ok: false,
			response: Response.json(
				{ error: "Choose an organization first." },
				{ status: 400 },
			),
		};
	}
	return { ok: true, user, orgId };
}

export const knowledgeHistoryKey = (orgId: string, userId: string) =>
	`knowledge/${orgId}/history/${userId}.v1.json`;

export async function knowledgeHistoryBucket(
	user: CurrentUser,
	orgId: Organisation.OrganisationId,
) {
	const { access } = await Storage.getS3WritableAccessForUser(
		user.id,
		orgId,
	).pipe(runPromise);
	return access;
}
