import { useApp } from "../store/app";
import { ProviderIcon, providerName } from "./icons";
import { Card } from "./ui";

export function ProfileView({ id }: { id: string }) {
  const account = useApp((s) => s.accounts.find((a) => a.id === id));

  if (!account) {
    return (
      <div className="p-8 text-sm text-[var(--text-2)]">Account not found.</div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl p-8">
      <div className="mb-6 flex items-center gap-3">
        <span className="text-[var(--text-2)]">
          <ProviderIcon provider={account.provider} size={20} />
        </span>
        <div>
          <h1 className="text-lg font-semibold text-[var(--text)]">{account.label}</h1>
          <div className="text-xs text-[var(--text-3)]">{providerName(account.provider)}</div>
        </div>
      </div>

      <Card className="flex flex-col items-center gap-2 px-6 py-16 text-center">
        <p className="text-sm font-medium text-[var(--text)]">Browse coming in the next update</p>
        <p className="max-w-sm text-sm text-[var(--text-2)]">
          File browsing, sizes, and downloads for this account land in the next phase.
        </p>
      </Card>
    </div>
  );
}
