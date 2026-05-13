/**
 * URL utility helpers shared across audio facade classes.
 *
 * Uses a simple character-by-character loop rather than a regex so that
 * CodeQL (javascript/polynomial-redos) does not flag calls on
 * user-controlled input. The `/\/+$/` regex is equivalent in behaviour but
 * triggers the "polynomial regular expression used on uncontrolled data" rule
 * because the quantifier runs over external input.
 */

/**
 * Remove one or more trailing forward-slash characters from `url`.
 *
 * @example
 * stripTrailingSlashes("https://api.octomil.com///") // "https://api.octomil.com"
 * stripTrailingSlashes("https://api.octomil.com")    // "https://api.octomil.com"
 */
export function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") {
    end -= 1;
  }
  return end === url.length ? url : url.slice(0, end);
}
