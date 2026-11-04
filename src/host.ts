// Where this ReaderCount lives, for links in emails and pages.

/** ReaderCount's home page and code. */
export const HOME_URL = "https://paulobrien.dev/readercount/";
export const REPO_URL = "https://github.com/pobren/readercount";

/** The address emails come from: MAIL_FROM, or readercount@ the stats address's own domain. */
export function mailFrom(env: { MAIL_FROM?: string; APP_HOST?: string }): string {
	if (env.MAIL_FROM) return env.MAIL_FROM;
	const host = (env.APP_HOST ?? "").replace(/:\d+$/, "");
	return `readercount@${host.split(".").length > 2 ? host.split(".").slice(1).join(".") : host}`;
}
