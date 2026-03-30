import React from "react";

export function StatBox({ label, value, icon, color }: {
  label: string;
  value: string;
  icon: React.ReactNode;
  color: string;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] text-muted-foreground flex items-center gap-1">{icon} {label}</p>
      <p className={`text-xl font-bold ${color}`}>{value}</p>
    </div>
  );
}
