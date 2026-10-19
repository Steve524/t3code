import type { EnvironmentId, UnifiedSettings } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useId, useRef, useState } from "react";

import { SecretInput } from "../../../components/settings/SecretInput";
import { SettingsSection } from "../../../components/settings/settingsLayout";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { toastManager } from "../../../components/ui/toast";
import { useEnvironmentSettings } from "../../../hooks/useSettings";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { crewSecretStatus } from "./crewsSettings.logic";
import { CrewConfirm } from "./CrewConfirm";

const readCrewSecrets = (settings: UnifiedSettings) => settings.forkCrewSecrets;

/**
 * Values for `${secret:NAME}` in crew MCP servers' env, kept in the server's secret store as
 * `crew-NAME`. Write-only: a saved value is never shown again, only that it is set.
 */
export function CrewSecrets({
  environmentId,
  environmentLabel,
  referenced,
}: {
  environmentId: EnvironmentId;
  environmentLabel: string;
  /** Names the selected project's MCP servers read. */
  referenced: readonly string[];
}) {
  const saved = useEnvironmentSettings(environmentId, readCrewSecrets) ?? {};
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save crew secret",
  });
  const [name, setName] = useState("");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const locked = useRef(false);
  const nameHintId = useId();
  const status = crewSecretStatus(saved, referenced);
  const trimmedName = name.trim();
  const validName = /^[\w-]+$/u.test(trimmedName);
  const isSaved = status.saved.includes(trimmedName);

  // Per entry: the server merges the patch, and `null` removes the secret from its store.
  const save = async (value: string | null) => {
    if (!canWrite || locked.current || !validName || (value !== null && !value.trim())) return;
    locked.current = true;
    setSaving(true);
    const result = await updateSettings({
      environmentId,
      input: { patch: { forkCrewSecrets: { [trimmedName]: value } } },
    }).finally(() => {
      locked.current = false;
      setSaving(false);
    });
    if (result._tag === "Success") {
      setDraft("");
      toastManager.add({
        type: "success",
        title: value === null ? "Crew secret removed" : "Crew secret saved",
      });
    }
  };

  return (
    <SettingsSection title="Crew secrets" id="crew-secrets" variant="plain">
      <form
        className="grid min-w-0 gap-3 px-4"
        aria-busy={saving}
        onSubmit={(event) => {
          event.preventDefault();
          if (validName && draft.trim()) void save(draft.trim());
        }}
      >
        {/* Locked while saving: a successful save clears the draft. */}
        <fieldset disabled={saving || !canWrite} className="contents">
          <p className="text-xs text-muted-foreground">
            A crew MCP server reads <code>{"${secret:NAME}"}</code> in its env from here. Values
            stay on {environmentLabel}.
          </p>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor={`crew-secret-name-${environmentId}`}>Name</Label>
              <Input
                id={`crew-secret-name-${environmentId}`}
                autoComplete="off"
                size="sm"
                placeholder="GITHUB_TOKEN"
                value={name}
                aria-invalid={name.length > 0 && !validName}
                aria-describedby={nameHintId}
                required
                onChange={(event) => {
                  setName(event.target.value);
                  setDraft("");
                }}
              />
              <p id={nameHintId} className="text-xs text-muted-foreground">
                Use letters, numbers, underscores, or hyphens.
              </p>
            </div>
            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor={`crew-secret-value-${environmentId}`}>Value</Label>
              <SecretInput
                id={`crew-secret-value-${environmentId}`}
                size="sm"
                configured={isSaved}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
              {status.saved.length === 0 && status.missing.length === 0 ? (
                <span>No crew secrets saved.</span>
              ) : null}
              {[...status.saved, ...status.missing].map((secret) => (
                <Button
                  key={secret}
                  type="button"
                  size="sm-multiline"
                  className="min-w-0 max-w-full"
                  variant="ghost-muted"
                  onClick={() => {
                    setName(secret);
                    if (secret !== trimmedName) setDraft("");
                  }}
                >
                  <span className="min-w-0 break-all">
                    {secret} · {status.saved.includes(secret) ? "saved" : "not set"}
                  </span>
                </Button>
              ))}
            </div>
            <div className="flex shrink-0 gap-2">
              {isSaved ? (
                <CrewConfirm
                  action={`${environmentId}:secret:${trimmedName}:remove`}
                  label="Remove secret"
                  disabled={saving || !canWrite}
                  onConfirm={() => void save(null)}
                />
              ) : null}
              <Button type="submit" size="xs" disabled={!validName || !draft.trim()}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </fieldset>
        {!canWrite ? (
          <p className="text-xs text-muted-foreground">This connection cannot edit crew secrets.</p>
        ) : null}
      </form>
    </SettingsSection>
  );
}
