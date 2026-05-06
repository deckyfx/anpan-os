import React from "react";

export function Field({ label, type = "text", value, onChange, placeholder }: {
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="mb-4">
      <label className="block text-sm text-gray-400 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm
                   focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent
                   placeholder-gray-600"
      />
    </div>
  );
}
