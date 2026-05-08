import React from "react";

export function SubmitButton({ label, loading }: { label: string; loading: boolean }) {
  return (
    <button
      type="submit"
      disabled={loading}
      className="w-full bg-amber-500 hover:bg-amber-400 disabled:bg-amber-800 disabled:text-amber-600
                 text-gray-950 font-semibold rounded-lg px-4 py-2 text-sm transition-colors mt-2 mb-2"
    >
      {loading ? "Please wait…" : label}
    </button>
  );
}
