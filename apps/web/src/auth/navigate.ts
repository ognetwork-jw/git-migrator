/**
 * A full page load of `url`. Sign-in and sign-out leave the app (to the identity provider) or must
 * drop all client state, so they navigate the browser rather than the router.
 */
export function hardNavigate(url: string): void {
  window.location.assign(url);
}
