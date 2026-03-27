// ZipUpload.tsx
import { useEffect, useState } from "react";

export default function ZipUpload() {
  const [pct, setPct] = useState(0);
  const [stage, setStage] = useState("idle");
  const [detail, setDetail] = useState("");

  useEffect(() => {
    const off = window.zu.onProgress(({ stage, percent, detail }) => {
      setStage(stage);
      setPct(percent);
      setDetail(detail || "");
    });
    return () => off && off();
  }, []);

  const run = async () => {
    const res = await window.zu.run({
      folderPaths: [
        "C:\\Users\\Public\\TallyPrime\\data\\100000",
        "C:\\Users\\Public\\TallyPrime\\data\\100001",
      ],
      preserveFolderNames: true,
      encryption: "zipcrypto",
      password: "MyPass123",
      uploadUrl: "http://localhost:4000/upload",
      fields: { project: "tallydekho" },
    });

    if (!res.ok) alert("Failed: " + res.error);
    else alert("Uploaded!");
  };

  return (
    <div>
      <button onClick={run}>Zip & Upload</button>
      <div style={{ marginTop: 8 }}>
        <strong>{stage}</strong> — {detail}
      </div>
      <progress value={pct} max={100} style={{ width: 320 }} />
      <span> {pct}%</span>
    </div>
  );
}
