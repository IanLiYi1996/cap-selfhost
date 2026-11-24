/**
 * VideosPolicy enforces this for everything that authorises through it; the
 * paths that judge visibility on their own (link previews, oEmbed, public
 * collections) must check it too or they keep showing videos to anyone.
 *
 * Read the same way VideosPolicy reads it, so the two can never disagree.
 */
export const isSignInRequiredToView = () =>
	process.env.CAP_REQUIRE_SIGN_IN_TO_VIEW === "true";
