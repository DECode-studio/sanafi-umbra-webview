import sanafiIcon from '../assets/sanafi-icon.png';
import { getStatusClass, useApp } from './useApp';

export default function App() {
  const {
    bridgeReady,
    bridgeStatus,
    lastEvent,
    statusLabel,
    flowOutcome,
    lastSignature,
    sessionSummary,
    steps,
  } = useApp();

  return (
    <main className="min-h-screen bg-[#F9FAFB] text-[#111827]">
      <section className="mx-auto w-full max-w-md">
        <header className="mb-1 flex items-center justify-around px-[14px] py-[14px]">
          <div className="h-[27px] w-[27px]" />
          <h1 className="flex-1 pl-2 text-center text-[16px] font-semibold">Send Confirmation</h1>
          <img src={sanafiIcon} alt="Sanafi" className="h-[27px] w-[27px] rounded-full object-cover" />
        </header>

        <article className="mb-0 rounded-2xl border border-[#E5E7EB] bg-white px-0 py-1 shadow-panel">
          <div className="px-5 pt-4">
            <p className="text-[16px] text-[#111827]">Sent to:</p>
            <p className="mt-1 max-w-[250px] break-all text-[14px] text-[#111827]">
              {sessionSummary.receiver || "-"}
            </p>
            <p className="mt-[2px] text-[12px] text-[#6B7280]">Private Recipient</p>
          </div>
          <div className="mt-5 flex items-start justify-between px-5">
            <p className="text-[16px] text-[#111827]">Amount</p>
            <p className="text-[16px] font-semibold text-[#111827]">
              {sessionSummary.amountUi ? `${sessionSummary.amountUi} ${sessionSummary.mint || ''}` : '-'}
            </p>
          </div>
          <div className="mt-5 flex items-start justify-between px-5">
            <p className="text-[16px] text-[#111827]">Transaction Fee</p>
            <p className="text-[16px] font-semibold text-[#16A34A]">0 SANA</p>
          </div>
        </article>

        <article className="mx-5 mt-5 rounded-xl border border-[rgba(6,95,70,0.1)] bg-[rgba(6,95,70,0.05)] p-3">
          <div className="flex items-center gap-2">
            <span className="inline-block h-[20px] w-[20px] rounded-full border border-[#0B8D6A] bg-[#D1FAE5]" />
            <div>
              <p className="text-[14px] font-medium text-[#16A34A]">Umbra Private Mode Enabled</p>
              <p className="mt-[2px] text-[11px] text-[#6B7280]">Bridge: {bridgeReady ? "Connected" : "Initializing..."}</p>
            </div>
          </div>
        </article>

        <article className="mt-6 flex items-center justify-center px-5">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[#16A34A]" />
          <p className="ml-[10px] text-[14px] font-medium text-[#111827]">{statusLabel}</p>
        </article>

        <article className="mt-[30px] rounded-2xl bg-linear-to-r from-[#0A6B53] to-[#0B8D6A] px-4 py-5 text-white">
          <div className="flex items-center justify-between">
            <p className="text-[16px] font-semibold">Total</p>
            <p className="text-[16px] font-bold">
                {sessionSummary.amountUi ? `${sessionSummary.amountUi} ${sessionSummary.mint || ''}` : '-'}
              </p>
          </div>
        </article>

        <button
          type="button"
          className="m-4 mb-5 w-[calc(100%-32px)] rounded-[30px] bg-[#065f46] py-4 text-[16px] font-semibold text-white"
        >
          Send Crypto
        </button>

        <article className="mb-4 rounded-2xl border border-[#E5E7EB] bg-white p-4 shadow-panel">
          <p className="text-[14px] font-medium">Flow Progress</p>
          <ul className="mt-3 space-y-2">
            {steps.map((step) => (
              <li
                key={step.label}
                className="flex items-center justify-between rounded-xl border border-[#E5E7EB] bg-[#F9FAFB] px-3 py-2"
              >
                <span className="text-xs">{step.label}</span>
                <span className={`text-xs font-semibold ${getStatusClass(step.status)}`}>{step.status}</span>
              </li>
            ))}
          </ul>
        </article>

        <article className="rounded-2xl border border-[#E5E7EB] bg-white p-4 shadow-panel">
          <p className="text-[14px] font-medium">Bridge Diagnostics</p>
          <div className="mt-3 rounded-xl border border-[#E5E7EB] bg-[#F9FAFB] p-3">
            <p className="text-xs text-[#6B7280]">Channel</p>
            <p className="text-xs font-semibold">sanafi-umbra-bridge</p>
          </div>
          <div className="mt-3 rounded-xl border border-[#E5E7EB] bg-[#F9FAFB] p-3">
            <p className="text-xs text-[#6B7280]">Bridge status</p>
            <p className={`text-xs font-semibold ${bridgeReady ? 'text-sanafi-accent' : 'text-sanafi-warn'}`}>{bridgeStatus}</p>
          </div>
          <div className="mt-3 rounded-xl border border-[#E5E7EB] bg-[#F9FAFB] p-3">
            <p className="text-xs text-[#6B7280]">Last event</p>
            <p className="text-xs font-semibold">{lastEvent}</p>
          </div>
          {flowOutcome === 'SUCCESS' && <p className="mt-3 text-xs text-sanafi-accent">Transaction successful!</p>}
          {flowOutcome === 'FAILED' && <p className="mt-3 text-xs text-sanafi-danger">Transaction failed.</p>}
          {lastSignature ? <p className="mt-2 break-all text-[11px] text-[#6B7280]">Signature: {lastSignature}</p> : null}
        </article>
      </section>
    </main>
  );
}
