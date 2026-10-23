import { useEffect, useState, type FormEvent } from "react";
import { ConnectError, Code } from "@connectrpc/connect";
import { create, fromJson, toJson } from "@bufbuild/protobuf";
import { createControlClients, OpenShellDatamodelV1, OpenShellGatewayV1 } from "@klorq/quarshell-proto";

type ControlClients = ReturnType<typeof createControlClients>;

export function PolicyPanel({ clients, workspace, sandboxes }: { clients: ControlClients; workspace: string; sandboxes: { name: string; workspace: string }[] }) {
  const [proposals, setProposals] = useState<{ id: string; sandboxName: string; ruleName: string; rationale: string; securityNotes: string; reviewToken: string; createdAtUnixMs: bigint; rule: unknown }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refreshProposals() {
    const scope = create(OpenShellDatamodelV1.WorkspaceSelectorSchema, { selection: { case: "workspace", value: workspace || "default" } });
    const drafts = await Promise.all(sandboxes.map((sandbox) => clients.gateway.getDraftPolicy(create(OpenShellGatewayV1.GetDraftPolicyRequestSchema, { workspaceScope: scope, sandbox: sandbox.name, statusFilter: "pending" }))));
    setProposals(drafts.flatMap((draft, index) => draft.chunks.map((chunk) => ({
      id: chunk.id,
      sandboxName: sandboxes[index].name,
      ruleName: chunk.ruleName,
      rationale: chunk.rationale,
      securityNotes: chunk.securityNotes,
      reviewToken: chunk.reviewToken,
      createdAtUnixMs: BigInt((chunk.createdTime?.seconds ?? 0n) * 1000n + BigInt(Math.floor((chunk.createdTime?.nanos ?? 0) / 1_000_000))),
      rule: chunk.proposedRule ?? null,
    }))));
  }

  useEffect(() => {
    let alive = true;
    setError("");
    void refreshProposals().catch((err: unknown) => { if (alive) setError(userError(err)); });
    return () => { alive = false; };
  }, [clients, workspace, sandboxes]);

  async function decideProposal(proposal: typeof proposals[number], approve: boolean) {
    const verb = approve ? "Approve" : "Reject";
    if (!window.confirm(`${verb} policy proposal ${proposal.id}?`)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const workspaceScope = create(OpenShellDatamodelV1.WorkspaceSelectorSchema, { selection: { case: "workspace", value: workspace || "default" } });
      if (approve) await clients.gateway.approveDraftChunk(create(OpenShellGatewayV1.ApproveDraftChunkRequestSchema, { workspaceScope, sandbox: proposal.sandboxName, chunkId: proposal.id, reviewToken: proposal.reviewToken, requestId: crypto.randomUUID() }));
      else await clients.gateway.rejectDraftChunk(create(OpenShellGatewayV1.RejectDraftChunkRequestSchema, { workspaceScope, sandbox: proposal.sandboxName, chunkId: proposal.id, reason: "Rejected from the control console.", requestId: crypto.randomUUID() }));
      await refreshProposals();
      setNotice(`Proposal ${approve ? "approved" : "rejected"}.`);
    } catch (err) { setError(userError(err)); }
    finally { setBusy(false); }
  }

  return <section className="workspace-panel">
    <div className="intro"><div><div className="eyebrow">WORKSPACE · {workspace}</div><h1>Policies</h1><p>Review OpenShell policy drafts for sandboxes in this workspace.</p></div></div>
    {error && <div className="callout error">{error}<button onClick={() => setError("")}>Dismiss</button></div>}
    {notice && <div className="callout success">{notice}<button onClick={() => setNotice("")}>Dismiss</button></div>}
    <div className="panel-grid">
      <section className="panel-card"><div className="panel-heading"><div><div className="eyebrow">POLICY PROPOSALS</div><h2>Awaiting review <span>{proposals.length}</span></h2></div></div>
        {proposals.length ? <div className="proposal-list">{proposals.map((proposal) => <article className="proposal" key={proposal.id}><div className="proposal-meta"><span>{proposal.sandboxName}</span><time>{formatTime(proposal.createdAtUnixMs)}</time></div><h3>{proposal.rationale || proposal.ruleName || "Policy change"}</h3>{proposal.securityNotes && <p className="security-note">Security review: {proposal.securityNotes}</p>}{proposal.rule !== null && <pre>{JSON.stringify(proposal.rule, null, 2)}</pre>}<div className="panel-actions"><button disabled={busy} onClick={() => void decideProposal(proposal, false)}>Reject</button><button className="panel-primary" disabled={busy} onClick={() => void decideProposal(proposal, true)}>Approve</button></div></article>)}</div> : <p className="panel-empty">No pending policy drafts in this workspace.</p>}
      </section>
    </div>
  </section>;
}

export function ProvidersPanel({ clients, workspace }: { clients: ControlClients; workspace: string }) {
  const [profiles, setProfiles] = useState<OpenShellGatewayV1.ProviderProfile[]>([]);
  const [selectedID, setSelectedID] = useState("");
  const [profileJSON, setProfileJSON] = useState("");
  const [importID, setImportID] = useState("");
  const [importJSON, setImportJSON] = useState('{\n  "id": "my-provider",\n  "displayName": "My Provider",\n  "category": "PROVIDER_PROFILE_CATEGORY_OTHER"\n}');
  const [credentialProvider, setCredentialProvider] = useState("");
  const [credentialKey, setCredentialKey] = useState("");
  const [credentialValue, setCredentialValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function refreshProfiles(selectID = selectedID) {
    const workspaceScope = providerWorkspace(workspace);
    const result: OpenShellGatewayV1.ProviderProfile[] = [];
    let pageToken = "";
    do {
      const page = await clients.gateway.listProviderProfiles(create(OpenShellGatewayV1.ListProviderProfilesRequestSchema, { workspaceScope, pageSize: 100, pageToken }));
      result.push(...page.profiles);
      pageToken = page.nextPageToken;
    } while (pageToken);
    setProfiles(result);
    const next = result.some((item) => item.id === selectID) ? selectID : result[0]?.id ?? "";
    setSelectedID(next);
  }

  useEffect(() => {
    let alive = true;
    void refreshProfiles().catch((err: unknown) => { if (alive) setError(userError(err)); });
    return () => { alive = false; };
  }, [clients, workspace]);

  useEffect(() => {
    const selected = profiles.find((item) => item.id === selectedID);
    setProfileJSON(selected ? JSON.stringify(toJson(OpenShellGatewayV1.ProviderProfileSchema, selected), null, 2) : "");
  }, [profiles, selectedID]);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      if (!selected || selected.source !== "user" || selected.scope !== "workspace") throw new Error("Only workspace-owned provider profiles can be edited here.");
      const profile = fromJson(OpenShellGatewayV1.ProviderProfileSchema, JSON.parse(profileJSON));
      if (profile.id !== selectedID) throw new Error("The profile id cannot be changed during an update.");
      await clients.gateway.updateProviderProfiles(create(OpenShellGatewayV1.UpdateProviderProfilesRequestSchema, {
        workspaceScope: providerWorkspace(workspace),
        id: selectedID,
        expectedResourceVersion: selected.resourceVersion,
        requestId: crypto.randomUUID(),
        profile: create(OpenShellGatewayV1.ProviderProfileImportItemSchema, { profile }),
      }));
      setNotice(`Saved provider profile ${selectedID}.`);
      await refreshProfiles(selectedID);
    } catch (err) { setError(userError(err)); }
    finally { setBusy(false); }
  }

  async function deleteProfile() {
    if (!selectedID || !window.confirm(`Delete custom provider profile ${selectedID}?`)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await clients.gateway.deleteProviderProfile(create(OpenShellGatewayV1.DeleteProviderProfileRequestSchema, { workspaceScope: providerWorkspace(workspace), id: selectedID, requestId: crypto.randomUUID() }));
      setNotice(`Deleted provider profile ${selectedID}.`);
      await refreshProfiles("");
    } catch (err) { setError(userError(err)); }
    finally { setBusy(false); }
  }

  async function importProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const profile = fromJson(OpenShellGatewayV1.ProviderProfileSchema, JSON.parse(importJSON));
      profile.id = importID.trim();
      const result = await clients.gateway.importProviderProfiles(create(OpenShellGatewayV1.ImportProviderProfilesRequestSchema, {
        workspaceScope: providerWorkspace(workspace),
        requestId: crypto.randomUUID(),
        profiles: [create(OpenShellGatewayV1.ProviderProfileImportItemSchema, { profile })],
      }));
      const diagnostic = result.diagnostics.find((item) => item.severity === "error");
      if (!result.imported || diagnostic) throw new Error(diagnostic?.message || "Gateway rejected the provider profile.");
      setImportID(""); setImportJSON('{\n  "id": "my-provider",\n  "displayName": "My Provider",\n  "category": "PROVIDER_PROFILE_CATEGORY_OTHER"\n}');
      setNotice(`Imported provider profile ${profile.id}.`);
      await refreshProfiles(profile.id);
    } catch (err) { setError(userError(err)); }
    finally { setBusy(false); }
  }

  async function saveCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      await clients.gateway.updateProvider(create(OpenShellGatewayV1.UpdateProviderRequestSchema, {
        workspaceScope: providerWorkspace(workspace),
        requestId: crypto.randomUUID(),
        provider: create(OpenShellDatamodelV1.ProviderSchema, {
          metadata: create(OpenShellDatamodelV1.ObjectMetaSchema, { name: credentialProvider.trim() }),
          credentials: { [credentialKey.trim()]: credentialValue },
        }),
      }));
      setCredentialValue("");
      setNotice(`Updated ${credentialKey.trim()} for ${credentialProvider.trim()}.`);
    } catch (err) { setError(userError(err)); }
    finally { setBusy(false); }
  }

  const selected = profiles.find((item) => item.id === selectedID);
  const editable = selected?.source === "user" && selected.scope === "workspace";

  return <section className="workspace-panel">
    <div className="intro"><div><div className="eyebrow">WORKSPACE · {workspace}</div><h1>Providers</h1><p>Manage OpenShell provider profiles and update write-only credentials.</p></div></div>
    {error && <div className="callout error">{error}<button onClick={() => setError("")}>Dismiss</button></div>}
    {notice && <div className="callout success">{notice}<button onClick={() => setNotice("")}>Dismiss</button></div>}
    <div className="panel-grid providers-grid">
      <section className="panel-card"><div className="panel-heading"><div><div className="eyebrow">PROVIDER CATALOG</div><h2>Profiles <span>{profiles.length}</span></h2></div><select aria-label="Provider profile" value={selectedID} onChange={(event) => setSelectedID(event.target.value)}>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.id} · {profile.source}</option>)}</select></div>
        {selected ? <><div className="profile-tags"><span>{OpenShellGatewayV1.ProviderProfileCategory[selected.category].replace("PROVIDER_PROFILE_CATEGORY_", "")}</span><span>{selected.scope || "platform"}</span><span>{selected.source}</span></div><form onSubmit={(event) => void saveProfile(event)}><textarea className="yaml-editor provider-editor" aria-label="Provider profile JSON" spellCheck={false} readOnly={!editable} value={profileJSON} onChange={(event) => setProfileJSON(event.target.value)} /><div className="editor-footer"><span>{editable ? `Version ${selected.resourceVersion.toString()}` : "Built-in profile · read only"}</span>{editable && <div className="panel-actions"><button type="button" className="danger-outline" disabled={busy} onClick={() => void deleteProfile()}>Delete</button><button className="panel-primary" disabled={busy}>Save profile</button></div>}</div></form></> : <p className="panel-empty">No provider profiles are available in this workspace.</p>}
      </section>

      <section className="panel-card"><div className="panel-heading"><div><div className="eyebrow">CUSTOM PROFILE</div><h2>Import a profile</h2></div></div><form onSubmit={(event) => void importProfile(event)}><label className="panel-field">Profile ID<input required maxLength={63} value={importID} onChange={(event) => setImportID(event.target.value)} placeholder="my-provider" /></label><textarea className="yaml-editor provider-editor" aria-label="New provider profile JSON" spellCheck={false} required value={importJSON} onChange={(event) => setImportJSON(event.target.value)} /><div className="editor-footer"><span>Workspace scoped · OpenShell profile schema</span><button className="panel-primary" disabled={busy}>Import profile</button></div></form></section>

      <section className="panel-card"><div className="panel-heading"><div><div className="eyebrow">SECRET UPDATE</div><h2>Provider credentials</h2></div></div><p className="panel-help">Secret values are write-only in this console. The gateway checks workspace access and keeps values out of profile reads.</p><form onSubmit={(event) => void saveCredential(event)}><label className="panel-field">Provider name<input required maxLength={128} value={credentialProvider} onChange={(event) => setCredentialProvider(event.target.value)} placeholder="github" /></label><label className="panel-field">Credential key<input required maxLength={128} value={credentialKey} onChange={(event) => setCredentialKey(event.target.value)} placeholder="GITHUB_TOKEN" /></label><label className="panel-field">Secret value<input required type="password" autoComplete="new-password" value={credentialValue} onChange={(event) => setCredentialValue(event.target.value)} /></label><div className="editor-footer"><span>Values are never fetched back</span><button className="panel-primary" disabled={busy}>Save credential</button></div></form></section>
    </div>
  </section>;
}

function userError(err: unknown) {
  if (err instanceof ConnectError && err.code === Code.Unauthenticated) return "Session expired. Sign in again.";
  return err instanceof Error ? err.message : "Request failed. Try again.";
}

function providerWorkspace(name: string) {
  return create(OpenShellDatamodelV1.WorkspaceSelectorSchema, { selection: { case: "workspace", value: name } });
}

function formatTime(ms: bigint) {
  return ms ? new Date(Number(ms)).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
}
