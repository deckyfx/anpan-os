import React from "react";

export function AuthCard({ title, subtitle, children }: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-950 px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <span className="text-4xl">🍞</span>
          <h1 className="text-2xl font-bold text-white mt-2">anpan-os</h1>
          {subtitle && <p className="text-gray-400 text-sm mt-1">{subtitle}</p>}
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-xl">
          <h2 className="text-lg font-semibold text-white mb-5">{title}</h2>
          {children}
        </div>
      </div>
    </div>
  );
}
