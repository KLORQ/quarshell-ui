import { expect, test, type Page, type Route } from "@playwright/test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { createHash, generateKeyPairSync, sign as signJWT } from "node:crypto";
import {
  OpenShellGatewayV1,
} from "@klorq/quarshell-proto";

const issuer = "http://identity.test/dex";
const clientID = "console-test";
const denyCreateForPage = new WeakMap<Page, () => void>();
test.beforeEach(async ({ page }, testInfo) => {
  await mockGateway(page, testInfo.title !== "starts OIDC authorization with PKCE");
});

test("publishes installable desktop web app metadata", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");

  const response = await page.request.get("http://127.0.0.1:4173/manifest.webmanifest");
  expect(response.ok()).toBeTruthy();
  const manifest = await response.json() as { display: string; start_url: string; icons: { src: string; sizes: string; type: string }[] };
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/");
  expect(manifest.icons.map((icon) => icon.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));

  for (const icon of manifest.icons) {
    const iconResponse = await page.request.get(`http://127.0.0.1:4173${icon.src}`);
    expect(iconResponse.ok()).toBeTruthy();
    expect(iconResponse.headers()["content-type"]).toContain(icon.type);
  }
});

test("starts OIDC authorization with PKCE", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();

  await page.route(`${issuer}/.well-known/openid-configuration`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/keys`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
    }),
  }));
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, string>), kid: "console-test-key", use: "sig", alg: "RS256" };
  await page.route(`${issuer}/keys`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "http://127.0.0.1:4173" },
    body: JSON.stringify({ keys: [jwk] }),
  }));
  await page.route(`${issuer}/authorize**`, (route) => route.fulfill({ status: 200, body: "Identity provider" }));
  await page.route(`${issuer}/token`, async (route) => {
    const form = new URLSearchParams(route.request().postData() ?? "");
    const verifier = form.get("code_verifier") ?? "";
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(authorization.searchParams.get("code_challenge"));
    expect(form.get("grant_type")).toBe("authorization_code");
    const idToken = signedToken(privateKey, {
      iss: issuer,
      sub: "alice@example.test",
      aud: clientID,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      nonce: authorization.searchParams.get("nonce"),
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "http://127.0.0.1:4173" },
      body: JSON.stringify({ access_token: "test-access-token", token_type: "Bearer", expires_in: 3600, scope: "openid profile", id_token: idToken }),
    });
  });
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(new RegExp(`${issuer.replaceAll(".", "\\.")}/authorize`));

  const authorization = new URL(page.url());
  expect(authorization.searchParams.get("response_type")).toBe("code");
  expect(authorization.searchParams.get("client_id")).toBe(clientID);
  expect(authorization.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:4173/auth/callback");
  expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorization.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);

  await page.goto(`http://127.0.0.1:4173/auth/callback?code=test-code&state=${encodeURIComponent(authorization.searchParams.get("state") ?? "")}`);
  await expect(page.getByRole("heading", { name: "Sandboxes" })).toBeVisible();
  await expect(page.getByText("alice@example.test").first()).toBeVisible();
  await expect(page).toHaveURL("http://127.0.0.1:4173/");
});

test("restores the tab session and opens workspace policy and provider screens", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sandboxes" })).toBeVisible();
  await expect(page.getByText("running", { exact: true }).first()).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Sandboxes" })).toBeVisible();

  await page.getByRole("button", { name: "Policies" }).click();
  await expect(page.getByRole("heading", { name: "Policies" })).toBeVisible();
  await expect(page.getByText("Allow package mirror")).toBeVisible();
  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("No pending policy drafts in this workspace.")).toBeVisible();

  await page.getByRole("button", { name: "Providers" }).click();
  await expect(page.getByRole("heading", { name: "Providers" })).toBeVisible();
  await expect(page.getByLabel("Provider profile JSON", { exact: true })).toHaveValue(/"id": "github"/);
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Saved provider profile github.")).toBeVisible();
  await page.getByLabel("Profile ID").fill("my-custom");
  await page.getByRole("button", { name: "Import profile" }).click();
  await expect(page.getByText("Imported provider profile my-custom.")).toBeVisible();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Deleted provider profile my-custom.")).toBeVisible();
  await page.getByLabel("Provider name").fill("github");
  await page.getByLabel("Credential key").fill("GITHUB_TOKEN");
  await page.getByLabel("Secret value").fill("secret-value");
  await page.getByRole("button", { name: "Save credential" }).click();
  await expect(page.getByText("Updated GITHUB_TOKEN for github.")).toBeVisible();
});

test("creates, stops, and deletes a sandbox through the workspace API", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sandboxes" })).toBeVisible();

  await page.getByRole("button", { name: "New sandbox" }).click();
  await page.getByLabel("Sandbox name").fill("browser-box");
  await page.getByLabel("Container image").fill("alpine:3.22");
  await page.getByRole("button", { name: "Create sandbox" }).click();
  await expect(page.getByRole("row", { name: /browser-box/ })).toBeVisible();

  await page.getByRole("row", { name: /browser-box/ }).click();
  await expect(page.getByText("Runtime status", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeEnabled();

  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("row", { name: /browser-box/ })).toHaveCount(0);
});

test("shows a workspace permission error from a denied create action", async ({ page }) => {
  denyCreateForPage.get(page)?.();
  await page.goto("/");
  await page.getByRole("button", { name: "New sandbox" }).click();
  await page.getByLabel("Sandbox name").fill("denied-box");
  await page.getByLabel("Container image").fill("alpine:3.22");
  await page.getByRole("button", { name: "Create sandbox" }).click();
  await expect(page.getByText("sandbox write access denied")).toBeVisible();
});

test("keeps native console navigation available in the installed mobile layout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Sandboxes/ })).toBeVisible();
  await page.getByRole("button", { name: "Policies" }).click();
  await expect(page.getByRole("heading", { name: "Policies" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

async function mockGateway(page: Page, restoreSession = true) {
  let sandboxes = [sandbox("web-demo", "running")];
  let proposals = [{
    id: "proposal-1", sandboxName: "web-demo", status: "pending", intentSummary: "Allow package mirror",
    ruleName: "package-mirror", ruleYaml: "host: packages.example.test", rationale: "Needed for builds.",
    securityNotes: "Review host scope.", confidence: 0.95, hosts: ["packages.example.test"], rejectionReason: "",
    validationResult: "valid", securityFlagged: false, createdAtUnixMs: BigInt(Date.now()), decidedAtUnixMs: 0n,
  }];
  let nativeProfiles = [{ id: "github", displayName: "GitHub", description: "GitHub API", category: OpenShellGatewayV1.ProviderProfileCategory.PROVIDER_PROFILE_CATEGORY_SOURCE_CONTROL, source: "user", scope: "workspace", resourceVersion: 1n }];
  let denyCreate = false;
  denyCreateForPage.set(page, () => { denyCreate = true; });

  const workspaceSummary = () => ({
    name: "default", callerRole: "owner", memberCount: 1, resourceVersion: 1n,
    updatedAtUnixMs: BigInt(Date.now()),
  });

  if (restoreSession) {
    await page.addInitScript(({ authIssuer, authClientID }) => {
      window.sessionStorage.setItem(`oidc.user:${authIssuer}:${authClientID}`, JSON.stringify({
        access_token: "test-access-token",
        token_type: "Bearer",
        scope: "openid profile",
        profile: { sub: "alice@example.test" },
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }));
    }, { authIssuer: issuer, authClientID: clientID });
  }

  await page.route("**/auth/oidc-config", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ issuer, audience: "cautem-test" }),
  }));

  await page.route("**/openshell.v1.OpenShell/**", async (route) => {
    const method = new URL(route.request().url()).pathname.split("/").at(-1) ?? "";
    switch (method) {
      case "GetCurrentUser": return binary(route, OpenShellGatewayV1.GetCurrentUserResponseSchema, { subject: "alice@example.test", roles: ["workspace_admin"], scopes: ["sandbox:write"] });
      case "ListWorkspaces": return binary(route, OpenShellGatewayV1.ListWorkspacesResponseSchema, { workspaces: [{ metadata: { name: "default" }, memberCount: 1 }] });
      case "ListProviderProfiles": return binary(route, OpenShellGatewayV1.ListProviderProfilesResponseSchema, { profiles: nativeProfiles, nextPageToken: "" });
      case "UpdateProviderProfiles": {
        const request = fromBinary(OpenShellGatewayV1.UpdateProviderProfilesRequestSchema, route.request().postDataBuffer() ?? new Uint8Array());
        const updated = { ...(request.profile?.profile ?? {}), source: "user", scope: "workspace", resourceVersion: BigInt(Number(nativeProfiles.find((item) => item.id === request.id)?.resourceVersion ?? 0n) + 1) };
        nativeProfiles = nativeProfiles.map((item) => item.id === request.id ? updated as typeof item : item);
        return binary(route, OpenShellGatewayV1.UpdateProviderProfilesResponseSchema, { profile: updated, updated: true });
      }
      case "ImportProviderProfiles": {
        const request = fromBinary(OpenShellGatewayV1.ImportProviderProfilesRequestSchema, route.request().postDataBuffer() ?? new Uint8Array());
        const imported = { ...(request.profiles[0]?.profile ?? {}), source: "user", scope: "workspace", resourceVersion: 1n };
        nativeProfiles = [...nativeProfiles, imported as typeof nativeProfiles[number]];
        return binary(route, OpenShellGatewayV1.ImportProviderProfilesResponseSchema, { profiles: [imported], imported: true });
      }
      case "DeleteProviderProfile": {
        const request = fromBinary(OpenShellGatewayV1.DeleteProviderProfileRequestSchema, route.request().postDataBuffer() ?? new Uint8Array());
        nativeProfiles = nativeProfiles.filter((item) => item.id !== request.id);
        return binary(route, OpenShellGatewayV1.DeleteProviderProfileResponseSchema, { outcome: OpenShellGatewayV1.DeletionOutcome.DELETION_OUTCOME_COMPLETED });
      }
      case "ListSandboxes": return binary(route, OpenShellGatewayV1.ListSandboxesResponseSchema, { sandboxes: sandboxes.map((item) => nativeSandbox(item.name, item.registryStatus)), nextPageToken: "" });
      case "GetDraftPolicy": {
        const request = fromBinary(OpenShellGatewayV1.GetDraftPolicyRequestSchema, route.request().postDataBuffer() ?? new Uint8Array());
        return binary(route, OpenShellGatewayV1.GetDraftPolicyResponseSchema, {
          chunks: proposals.filter((item) => item.sandboxName === request.sandbox).map((item) => ({
            id: item.id, status: item.status, ruleName: item.ruleName, rationale: item.intentSummary,
            securityNotes: item.securityNotes, reviewToken: "review-token", createdTime: { seconds: BigInt(Math.floor(Number(item.createdAtUnixMs) / 1000)) },
            proposedRule: {},
          })),
        });
      }
      case "ApproveDraftChunk":
      case "RejectDraftChunk": proposals = []; return binary(route, method === "ApproveDraftChunk" ? OpenShellGatewayV1.ApproveDraftChunkResponseSchema : OpenShellGatewayV1.RejectDraftChunkResponseSchema, {});
      case "CreateSandbox": {
        if (denyCreate) {
          denyCreate = false;
          return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ code: "permission_denied", message: "sandbox write access denied" }) });
        }
        const request = fromBinary(OpenShellGatewayV1.CreateSandboxRequestSchema, route.request().postDataBuffer() ?? new Uint8Array());
        const created = sandbox(request.name, "running");
        sandboxes = [...sandboxes, created];
        return binary(route, OpenShellGatewayV1.SandboxResponseSchema, { sandbox: nativeSandbox(created.name, created.registryStatus, request.workspaceScope?.workspace ?? "default", request.spec?.template?.image ?? "alpine:3.22") });
      }
      case "StartSandbox":
      case "StopSandbox": {
        const request = fromBinary(method === "StartSandbox" ? OpenShellGatewayV1.StartSandboxRequestSchema : OpenShellGatewayV1.StopSandboxRequestSchema, route.request().postDataBuffer() ?? new Uint8Array());
        const nextStatus = method === "StartSandbox" ? "running" : "stopped";
        sandboxes = sandboxes.map((item) => item.name === request.name ? sandbox(item.name, nextStatus) : item);
        return binary(route, OpenShellGatewayV1.SandboxResponseSchema, { sandbox: nativeSandbox(request.name, nextStatus) });
      }
      case "DeleteSandbox": {
        const request = fromBinary(OpenShellGatewayV1.DeleteSandboxRequestSchema, route.request().postDataBuffer() ?? new Uint8Array());
        sandboxes = sandboxes.filter((item) => item.name !== request.name);
        return binary(route, OpenShellGatewayV1.DeleteSandboxResponseSchema, { outcome: OpenShellGatewayV1.DeletionOutcome.DELETION_OUTCOME_COMPLETED });
      }
      case "GetSandboxLogs": return binary(route, OpenShellGatewayV1.GetSandboxLogsResponseSchema, { lines: [] });
      case "ListServices": return binary(route, OpenShellGatewayV1.ListServicesResponseSchema, { services: [] });
      case "UpdateProvider": return binary(route, OpenShellGatewayV1.ProviderResponseSchema, { provider: { metadata: { name: "github" } } });
      default: throw new Error(`Unexpected OpenShell RPC: ${method}`);
    }
  });
}

function nativeSandbox(name: string, phase: string, workspace = "default", image = "alpine:3.22") {
  const phaseValue = phase === "running" ? OpenShellGatewayV1.SandboxPhase.READY : OpenShellGatewayV1.SandboxPhase.STOPPED;
  return { metadata: { id: `id-${name}`, name, workspace, resourceVersion: 2n }, status: { phase: phaseValue }, spec: { template: { image } } };
}

function sandbox(name: string, status: string) {
  return {
    name, workspace: "default", registryStatus: status, computeDriver: "docker", resourceVersion: 2n,
    updatedAtUnixMs: BigInt(Date.now()), runtimeStatusAvailable: true, id: `id-${name}`, image: "alpine:3.22",
    labels: {}, runtimeStatus: status,
  };
}

function signedToken(privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "console-test-key", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = signJWT("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

async function binary(route: Route, schema: any, value: any) {
  await route.fulfill({ status: 200, headers: { "Content-Type": "application/proto" }, body: Buffer.from(toBinary(schema, create(schema, value))) });
}
