import { jsPDF } from 'jspdf';
import { ROBOTO_REGULAR, ROBOTO_BOLD } from './fonts.js';

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(1);
  return `${String(mins).padStart(2, '0')}:${secs.padStart(4, '0')}`;
}

function stripExtension(name) {
  return name.replace(/\.[^.]+$/, '');
}

function addRobotoFont(doc) {
  doc.addFileToVFS('Roboto-Regular.ttf', ROBOTO_REGULAR);
  doc.addFont('Roboto-Regular.ttf', 'Roboto', 'normal');
  doc.addFileToVFS('Roboto-Bold.ttf', ROBOTO_BOLD);
  doc.addFont('Roboto-Bold.ttf', 'Roboto', 'bold');
}

export function exportMarkdown(entries, videoName) {
  const baseName = stripExtension(videoName || 'video');
  let md = `# Описание видео: ${videoName || 'video'}\n\n`;

  for (const entry of entries) {
    md += `## Кадр ${entry.index} — ${formatTime(entry.timeSeconds)}\n\n`;
    md += `${entry.text}\n\n`;
  }

  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${baseName}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportPdf(entries, videoName) {
  const baseName = stripExtension(videoName || 'video');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });

  addRobotoFont(doc);

  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 20;
  const maxWidth = pageWidth - margin * 2;
  let y = margin;

  doc.setFont('Roboto', 'bold');
  doc.setFontSize(16);
  doc.text(`Описание видео: ${videoName || 'video'}`, margin, y);
  y += 12;

  for (const entry of entries) {
    doc.setFont('Roboto', 'bold');
    doc.setFontSize(11);
    const header = `Кадр ${entry.index}  —  ${formatTime(entry.timeSeconds)}`;
    doc.text(header, margin, y);
    y += 7;

    doc.setFont('Roboto', 'normal');
    doc.setFontSize(10);
    const lines = doc.splitTextToSize(entry.text, maxWidth);

    if (y + lines.length * 5 > doc.internal.pageSize.getHeight() - margin) {
      doc.addPage();
      y = margin;
    }

    doc.text(lines, margin, y);
    y += lines.length * 5 + 8;

    if (y > doc.internal.pageSize.getHeight() - margin) {
      doc.addPage();
      y = margin;
    }
  }

  doc.save(`${baseName}.pdf`);
}
