import { useMemo, useState, type FormEvent } from "react";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createControlTransport, OpenShellDatamodelV1, OpenShellGatewayV1 } from "@klorq/quarshell-proto";

export interface BrowserService {
  name: string;
  sandboxName: string;
  port: number;
  authorizationMode?: "strip" | "bearer-passthrough";
}

interface ServicesPanelProps {
  sandboxName: string;
  workspace: string;
  accessToken: string;
  services: BrowserService[];
  enabled: boolean;
  onChanged: () => void;
}

export function ServicesPanel({ sandboxName, workspace, accessToken, services, enabled, onChanged }: ServicesPanelProps) {
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [port, setPort] = useState("8080");
  const [authorizationMode, setAuthorizationMode] = useState<"strip" | "bearer-passthrough">("strip");
  const gateway = useMemo(() => createClient(OpenShellGatewayV1.OpenShell, createControlTransport({
    baseUrl: window.location.origin,
    interceptors: [(next) => async (request) => { request.header.set("Authorization", `Bearer ${accessToken}`); return next(request); }],
  })), [accessToken]);
  const workspaceScope = create(OpenShellDatamodelV1.WorkspaceSelectorSchema, { selection: { case: "workspace", value: workspace } });

  async function expose(name: string, targetPort: number, mode = authorizationMode) {
    setMutating(true); setError("");
    try {
      const response = await gateway.exposeService(create(OpenShellGatewayV1.ExposeServiceRequestSchema, {
        sandbox: sandboxName, name, targetPort, domain: true,
        workspaceScope,
        authorizationMode: mode === "bearer-passthrough" ? OpenShellGatewayV1.ServiceAuthorizationMode.BEARER_PASSTHROUGH : OpenShellGatewayV1.ServiceAuthorizationMode.STRIP,
      }));
      setServiceName("");
      onChanged();
      if (response.url) window.open(response.url, "_blank", "noopener,noreferrer");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not expose this service."); }
    finally { setMutating(false); }
  }

  async function remove(service: BrowserService) {
    setMutating(true); setError("");
    try {
      await gateway.deleteService(create(OpenShellGatewayV1.DeleteServiceRequestSchema, {
        sandbox: sandboxName, name: service.name, workspaceScope, allowMissing: true,
      }));
      onChanged();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not remove this service."); }
    finally { setMutating(false); }
  }

  function submitExpose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const targetPort = Number(port);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(serviceName) || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      setError("Enter a DNS service name and a port from 1 to 65535."); return;
    }
    void expose(serviceName, targetPort);
  }

  return <section className="browser-services" aria-label="Sandbox services">
    <div className="services-heading"><div><div className="eyebrow">PUBLISHED SERVICES</div><p className="action-caption">OpenShell routes these endpoints on their service URLs.</p></div><span className="services-count">{services.length.toString().padStart(2, "0")}</span></div>
    <form className="service-expose-form" onSubmit={submitExpose}>
      <label>Service <input value={serviceName} onChange={(event) => setServiceName(event.target.value)} placeholder="web" maxLength={63} /></label>
      <label>Port <input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" type="number" min="1" max="65535" /></label>
      <label>Authorization <select value={authorizationMode} onChange={(event) => setAuthorizationMode(event.target.value as "strip" | "bearer-passthrough")}><option value="strip">Strip</option><option value="bearer-passthrough">Bearer passthrough</option></select></label>
      <button type="submit" disabled={!enabled || mutating}>Expose</button>
    </form>
    <button type="button" className="expose-display" disabled={!enabled || mutating} onClick={() => void expose("novnc", 6080)}>Expose noVNC on port 6080</button>
    {!services.length ? <p className="services-empty">No services have been exposed for this sandbox.</p> : <ul>{services.map((service) => <li key={service.name}>
      <div className="service-copy"><strong>{service.name}</strong><span>Port {service.port} · auth: {service.authorizationMode === "bearer-passthrough" ? "Bearer passthrough" : "strip"}</span></div>
      <div className="service-actions"><button type="button" disabled={!enabled} onClick={() => { void gateway.getService(create(OpenShellGatewayV1.GetServiceRequestSchema, { sandbox: sandboxName, name: service.name, workspaceScope })).then((endpoint) => { if (endpoint.url) window.open(endpoint.url, "_blank", "noopener,noreferrer"); }).catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not open this service.")); }}>Open ↗</button><button type="button" className="remove-service" disabled={mutating} onClick={() => void remove(service)} aria-label={`Remove ${service.name} service`}>×</button></div>
    </li>)}</ul>}
    {!enabled && services.length > 0 && <p className="action-caption">Start this sandbox before opening a service.</p>}
    {error && <p className="callout error service-error" role="alert">{error}</p>}
  </section>;
}
