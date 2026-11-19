import { validatedName, parsePackagePath } from "./prepared-publication.mjs";

export const GUIX_ARCHIVE_AUTHORITY_HEADER = "X-Lagoon-Registry-Archive-Authority";

function housePackage(name, { privateScopes, privateNames }) {
  return validatedName(name) &&
    (privateNames.includes(name) || privateScopes.some(scope => name.startsWith(scope + "/")));
}

export function guixArchiveRequest(request, configuration) {
  const url = new URL(request.url);
  if (url.origin !== configuration.origin) return false;

  const method = request.method.toUpperCase();
  try {
    const path = decodeURIComponent(url.pathname).replace(/^\/+/u, "");
    // Resuming publication and changing a tag both consult the archive store.
    if (method === "POST" && path.startsWith("-/publication-inputs/")) {
      const resume = /^-\/publication-inputs\/((?:@[^/]+\/)?[^/]+)\/[^/]+\/resume$/u.exec(path);
      return !!resume && housePackage(resume[1], configuration);
    }
    if (method === "PUT" && path.startsWith("-/package/")) {
      const tag = /^-\/package\/(.+)\/dist-tags\/[^/]+$/u.exec(path);
      return !!tag && housePackage(tag[1], configuration);
    }

    const { name, rest } = parsePackagePath(url.pathname);
    if (!housePackage(name, configuration)) return false;
    if (method === "GET" || method === "HEAD") {
      return rest.length === 2 && rest[0] === "-" && rest[1].endsWith(".tgz");
    }
    return method === "PUT" || method === "DELETE";
  } catch {
    return false; // Let the ordinary registry report malformed paths.
  }
}

export function withoutGuixArchiveAuthority(request) {
  if (!request.headers.has(GUIX_ARCHIVE_AUTHORITY_HEADER)) return request;
  const headers = new Headers(request.headers);
  headers.delete(GUIX_ARCHIVE_AUTHORITY_HEADER);
  return new Request(request, { headers });
}

/** Same-zone Workers Route fetch goes to the canonical hostname's native origin. */
export async function forwardGuixArchiveRequest(request, fetchOrigin = fetch) {
  const headers = new Headers(request.headers);
  headers.set(GUIX_ARCHIVE_AUTHORITY_HEADER, "guix");
  try {
    const response = await fetchOrigin(new Request(request, { headers, redirect: "manual" }));
    if (response.headers.get(GUIX_ARCHIVE_AUTHORITY_HEADER) === "guix" &&
        ![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
  } catch {
    // A mutation may have reached the owner. This route never retries it.
  }
  return Response.json({ error: "the declared Guix archive authority did not return a qualified response" }, { status: 502 });
}
