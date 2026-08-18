/**
 * Title helpers shared by the Mediathek release builder and the movie matcher.
 *
 * They live outside `services/mediathek.ts` so that `services/movie-matcher.ts`
 * can use them without creating an import cycle.
 */

/**
 * Mediathek titles carry broadcast/accessibility annotations in parentheses,
 * e.g. "Lost Country (Originalversion mit Untertitel)" or "Tatort
 * (Audiodeskription)". They are not part of the film's name and keep Radarr
 * from matching the release, so strip them before building a release title.
 */
const BROADCAST_ANNOTATION =
  /\s*\([^()]*(?:Untertitel|Audiodeskription|Originalversion|Originalfassung|Hörfassung|OmU|klare Sprache|Gebärdensprache|DGS)[^()]*\)/gi;

export function stripBroadcastAnnotations(title: string): string {
  return title.replace(BROADCAST_ANNOTATION, "").replace(/\s+/g, " ").trim();
}

/**
 * Serialised broadcasts of a feature film carry a part marker: ARTE aired
 * "Fabian oder Der Gang vor die Hunde" as "(1/4)" … "(4/4)", others use
 * "Teil 2 von 4". Such an entry is one quarter of the film, so it must never
 * be offered as the film itself.
 *
 * The marker is only recognised in parentheses (or in the explicit
 * "Teil x von y" wording) so that titles like "8 1/2" stay untouched.
 */
const PART_MARKER = /\(\s*\d{1,2}\s*[/|]\s*\d{1,2}\s*\)|\bteil\s+\d{1,2}\s+von\s+\d{1,2}\b/i;

export function hasPartMarker(title: string): boolean {
  return PART_MARKER.test(title);
}

/**
 * Accessibility versions carry an extra layer over the broadcast: audio
 * description speaks the picture over the dialogue, sign language burns an
 * interpreter into the frame, and "klare Sprache" is a simplified re-narration.
 * They are alternative renderings of the same episode, not the episode itself,
 * and the broadcaster sometimes offers *only* them once the regular version has
 * expired -- so they must never be handed out as the regular release.
 *
 * Language variants (OmU, Originalversion, Originalfassung) are deliberately
 * not covered: those are legitimate audio tracks of the work itself, and which
 * one a user wants is a matter of taste, not of correctness.
 */
const ACCESSIBILITY_VERSION =
  /\([^()]*(?:Audiodeskription|H(?:ö|oe)rfassung|H(?:ö|oe)rfilm|Geb(?:ä|ae)rdensprache|DGS|klare Sprache|Leichte Sprache)[^()]*\)/i;

export function isAccessibilityVersion(title: string): boolean {
  return ACCESSIBILITY_VERSION.test(title);
}
