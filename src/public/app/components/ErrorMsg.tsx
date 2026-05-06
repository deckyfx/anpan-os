import React from "react";

export function ErrorMsg({ message }: { message: string }) {
  return (
    <p className="text-red-400 text-sm mt-3 text-center">{message}</p>
  );
}
