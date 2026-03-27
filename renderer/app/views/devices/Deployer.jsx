// Any React component
import { useEffect, useState } from "react";

export default function Deployer() {
  const [pct, setPct] = useState(0);
  const [stage, setStage] = useState("idle");
  const [detail, setDetail] = useState("");

  useEffect(() => {
    const off = window.pkg.onProgress(({ stage, percent, detail }) => {
      setStage(stage);
      setPct(percent);
      setDetail(detail || "");
    });
    return () => off && off();
  }, []);

  const run = async () => {
    const res = await window.pkg.deployZip({
      //   url: "https://tallydekho-prod-data-backup-new.s3.ap-south-2.amazonaws.com/company-backups/100000-134026615443234410.zip",
      //   password: "LQPWYLPM", // or "" if not encrypted
      url: "http://localhost:4000/uploads/1758192674084-package-1758192673978.zip",
      password: "MySecret123",
      targetDir: "C:\\Users\\Public\\TallyPrime\\data\\100000",
    });
    if (!res.ok) alert("Failed: " + res.error);
    else alert("Deployed!");
  };

  return (
    <div>
      <button onClick={run}>Deploy Package</button>
      <div style={{ marginTop: 8 }}>
        <strong>{stage}</strong> — {detail}
      </div>
      <progress value={pct} max={100} style={{ width: 320 }} />
      <span> {pct}%</span>
    </div>
  );
}
