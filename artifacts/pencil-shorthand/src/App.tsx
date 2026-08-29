import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Activity, Check, CircleHelp, Info, PenLine, Plus, RotateCcw, Save, Settings2, Trash2, X } from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient();
const VIEWBOX_WIDTH = 1600;
const VIEWBOX_HEIGHT = 1000;
const WRITING_LINE_TOP = 438;
const WRITING_LINE_BOTTOM = 562;
const TEMPLATE_VIEWBOX_WIDTH = 480;
const TEMPLATE_VIEWBOX_HEIGHT = 240;
const TEMPLATE_LINE_TOP = 76;
const TEMPLATE_LINE_BOTTOM = 164;
const TEMPLATE_POINT_COUNT = 32;
const SYMBOL_STORAGE_KEY = 'pencil-shorthand-symbols';
const DISPLAY_DELAY_STORAGE_KEY = 'pencil-shorthand-display-delay';
const MIN_DISPLAY_DELAY = 100;
const MAX_DISPLAY_DELAY = 3000;
const DEFAULT_DISPLAY_DELAY = 1200;

type Point = { x: number; y: number };
type StrokeSegment = { points: Point[]; token?: string };
type Stroke = { id: number; points: Point[]; segments: StrokeSegment[] };
type CustomSymbol = { id: number; label: string; points: Point[] };
type Recognition = { token?: string; detail: string };

function pathFromPoints(points: Point[]) {
  if (!points.length) return '';
  return points.reduce((path, point, index) => {
    if (index === 0) return `M ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    return `${path} L ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
  }, '');
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pathLength(points: Point[]) {
  return points.slice(1).reduce((total, point, index) => total + distance(points[index], point), 0);
}

function resamplePoints(points: Point[], count: number) {
  if (!points.length) return [];
  if (points.length === 1) return Array.from({ length: count }, () => points[0]);

  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulative.push(cumulative[index - 1] + distance(points[index - 1], points[index]));
  }
  const total = cumulative[cumulative.length - 1];
  if (!total) return Array.from({ length: count }, () => points[0]);

  return Array.from({ length: count }, (_, index) => {
    const target = (index / (count - 1)) * total;
    let segment = 1;
    while (segment < cumulative.length - 1 && cumulative[segment] < target) segment += 1;
    const start = points[segment - 1];
    const end = points[segment];
    const span = cumulative[segment] - cumulative[segment - 1] || 1;
    const ratio = (target - cumulative[segment - 1]) / span;
    return {
      x: start.x + (end.x - start.x) * ratio,
      y: start.y + (end.y - start.y) * ratio,
    };
  });
}

function normalizePoints(points: Point[]) {
  const sampled = resamplePoints(points, TEMPLATE_POINT_COUNT);
  if (!sampled.length) return [];
  const xs = sampled.map((point) => point.x);
  const ys = sampled.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const scale = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY) || 1;
  return sampled.map((point) => ({
    x: (point.x - minX) / scale,
    y: (point.y - minY) / scale,
  }));
}

function verticalPosition(points: Point[], lineTop: number, lineBottom: number) {
  if (!points.length) return .5;
  const ys = points.map((point) => point.y);
  const center = (Math.min(...ys) + Math.max(...ys)) / 2;
  return (center - lineTop) / (lineBottom - lineTop);
}

function positionLabel(points: Point[]) {
  const position = verticalPosition(points, TEMPLATE_LINE_TOP, TEMPLATE_LINE_BOTTOM);
  if (position < .34) return 'Upper band';
  if (position > .66) return 'Lower band';
  return 'Middle band';
}

function normalizedPathDistance(first: Point[], second: Point[]) {
  const left = normalizePoints(first);
  const right = normalizePoints(second);
  if (!left.length || !right.length) return Infinity;

  const forward = left.reduce((total, point, index) => total + distance(point, right[index]), 0) / left.length;
  const reversed = left.reduce((total, point, index) => total + distance(point, right[right.length - index - 1]), 0) / left.length;
  return Math.min(forward, reversed);
}

function bestCustomMatch(points: Point[], symbols: CustomSymbol[]) {
  if (points.length < 3 || !symbols.length) return null;
  let closest: { symbol: CustomSymbol; shapeScore: number; positionScore: number } | null = null;
  for (const symbol of symbols) {
    const shapeScore = normalizedPathDistance(points, symbol.points);
    const positionScore = Math.abs(
      verticalPosition(points, WRITING_LINE_TOP, WRITING_LINE_BOTTOM)
      - verticalPosition(symbol.points, TEMPLATE_LINE_TOP, TEMPLATE_LINE_BOTTOM),
    );
    if (!closest || shapeScore + positionScore * .45 < closest.shapeScore + closest.positionScore * .45) {
      closest = { symbol, shapeScore, positionScore };
    }
  }
  return closest;
}

function recognizeCustomStroke(points: Point[], symbols: CustomSymbol[]): Recognition | null {
  const closest = bestCustomMatch(points, symbols);
  if (closest && closest.shapeScore <= .22 && closest.positionScore <= .28) {
    return { token: closest.symbol.label, detail: `Custom mark read as ${closest.symbol.label}.` };
  }
  return null;
}

function loadCustomSymbols(): CustomSymbol[] {
  try {
    const saved = window.localStorage.getItem(SYMBOL_STORAGE_KEY);
    if (!saved) return [];
    const parsed = JSON.parse(saved) as CustomSymbol[];
    return Array.isArray(parsed) ? parsed.filter((symbol) => symbol?.label && Array.isArray(symbol.points)) : [];
  } catch {
    return [];
  }
}

function loadDisplayDelay() {
  try {
    const saved = Number(window.localStorage.getItem(DISPLAY_DELAY_STORAGE_KEY));
    return Number.isFinite(saved) && saved >= MIN_DISPLAY_DELAY && saved <= MAX_DISPLAY_DELAY ? saved : DEFAULT_DISPLAY_DELAY;
  } catch {
    return DEFAULT_DISPLAY_DELAY;
  }
}

function formatDuration(milliseconds: number) {
  const seconds = milliseconds / 1000;
  return `${seconds % 1 === 0 ? seconds.toFixed(0) : seconds.toFixed(1)} sec`;
}

function isSpaceTap(points: Point[]) {
  if (!points.length) return false;
  const start = points[0];
  const end = points[points.length - 1];
  return start.x >= VIEWBOX_WIDTH * .82
    && start.y <= VIEWBOX_HEIGHT * .18
    && distance(start, end) <= 22
    && pathLength(points) <= 42
    && points.length <= 8;
}

function turnAngle(before: Point, corner: Point, after: Point) {
  const incoming = { x: corner.x - before.x, y: corner.y - before.y };
  const outgoing = { x: after.x - corner.x, y: after.y - corner.y };
  const incomingLength = Math.hypot(incoming.x, incoming.y);
  const outgoingLength = Math.hypot(outgoing.x, outgoing.y);
  if (!incomingLength || !outgoingLength) return 0;
  const cosine = (incoming.x * outgoing.x + incoming.y * outgoing.y) / (incomingLength * outgoingLength);
  return Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
}

function sharpCornerIndices(points: Point[]) {
  if (points.length < 9) return [];
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulative.push(cumulative[index - 1] + distance(points[index - 1], points[index]));
  }
  const total = cumulative[cumulative.length - 1];
  const minimumSegmentLength = Math.max(48, Math.min(88, total * .12));
  const lookDistance = Math.max(18, Math.min(42, total * .05));
  const candidates: { index: number; angle: number }[] = [];

  const firstIndexAt = (target: number) => {
    let index = 0;
    while (index < cumulative.length - 1 && cumulative[index] < target) index += 1;
    return index;
  };

  for (let index = 2; index < points.length - 2; index += 1) {
    if (cumulative[index] < minimumSegmentLength || total - cumulative[index] < minimumSegmentLength) continue;
    const beforeIndex = firstIndexAt(cumulative[index] - lookDistance);
    const afterIndex = firstIndexAt(cumulative[index] + lookDistance);
    if (beforeIndex === index || afterIndex === index || beforeIndex >= afterIndex) continue;
    const angle = turnAngle(points[beforeIndex], points[index], points[afterIndex]);
    if (angle >= 52) candidates.push({ index, angle });
  }

  const selected: { index: number; angle: number }[] = [];
  const minimumCornerGap = Math.max(48, minimumSegmentLength * .9);
  for (const candidate of candidates.sort((first, second) => second.angle - first.angle)) {
    if (selected.some((other) => Math.abs(cumulative[other.index] - cumulative[candidate.index]) < minimumCornerGap)) continue;
    selected.push(candidate);
  }
  return selected.sort((first, second) => first.index - second.index).map((candidate) => candidate.index);
}

function splitAtSharpAngles(points: Point[]) {
  const corners = sharpCornerIndices(points);
  if (!corners.length) return [points];
  const pieces: Point[][] = [];
  let start = 0;
  for (const corner of corners) {
    pieces.push(points.slice(start, corner + 1));
    start = corner;
  }
  pieces.push(points.slice(start));
  return pieces;
}

function recognizeStroke(points: Point[]): Recognition {
  if (points.length < 3) return { detail: 'That mark was too brief to read.' };

  const start = points[0];
  const end = points[points.length - 1];
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  const direct = distance(start, end);
  const drawn = pathLength(points);
  const linearity = direct ? drawn / direct : Infinity;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const angle = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);
  const closed = distance(start, end) <= Math.max(24, Math.max(width, height) * .27)
    && width >= 28
    && height >= 28
    && points.length >= 9
    && drawn > Math.max(width, height) * 1.45;

  if (closed) return { token: 'E', detail: 'Loop read as E.' };
  if (width >= 60 && dx >= 60 && Math.abs(dy) <= Math.max(22, height * .7) && linearity <= 1.18) {
    return { token: 'M', detail: 'Horizontal mark read as M.' };
  }
  if (height >= 50 && dy <= -50 && Math.abs(dx) <= Math.max(28, width * .65) && linearity <= 1.3) {
    return { token: '-ing', detail: 'Upstroke read as -ing.' };
  }
  if (dx >= 38 && dy >= 38 && angle >= 23 && angle <= 67 && linearity <= 1.3) {
    return { token: 'T', detail: 'Diagonal mark read as T.' };
  }
  return { detail: 'Mark kept, but not yet in the vocabulary.' };
}

function recognizeJoinedStroke(points: Point[], symbols: CustomSymbol[]) {
  const closeCustomMatch = bestCustomMatch(points, symbols);
  if (closeCustomMatch && closeCustomMatch.shapeScore <= .3 && closeCustomMatch.positionScore <= .38) return null;
  const pieces = splitAtSharpAngles(points);
  if (pieces.length < 2 || pieces.length > 5) return null;
  const recognitions = pieces.map((piece) => recognizeCustomStroke(piece, symbols) ?? recognizeStroke(piece));
  if (recognitions.some((recognition) => !recognition.token)) return null;
  const segments = pieces.map((piece, index) => ({ points: piece, token: recognitions[index].token }));
  const tokens = segments.map((segment) => segment.token).join('');
  return {
    segments,
    detail: `Joined stroke split into ${segments.length} symbols: ${tokens}.`,
  };
}

function statusIcon(status: string) {
  if (status === 'success') return <Check aria-hidden="true" />;
  if (status === 'writing') return <Activity aria-hidden="true" />;
  return <Info aria-hidden="true" />;
}

function Home() {
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [markCount, setMarkCount] = useState(0);
  const [currentStroke, setCurrentStroke] = useState<Point[]>([]);
  const [translatedText, setTranslatedText] = useState('');
  const [status, setStatus] = useState({ label: 'Ready when you are.', tone: 'ready' });
  const [inputMode, setInputMode] = useState('Pencil ready');
  const [showVocabulary, setShowVocabulary] = useState(false);
  const [showSymbols, setShowSymbols] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [customSymbols, setCustomSymbols] = useState<CustomSymbol[]>(loadCustomSymbols);
  const [displayDelay, setDisplayDelay] = useState(loadDisplayDelay);
  const [isTeaching, setIsTeaching] = useState(false);
  const [symbolLabel, setSymbolLabel] = useState('');
  const [templatePoints, setTemplatePoints] = useState<Point[]>([]);
  const [templateStatus, setTemplateStatus] = useState('Draw one clear mark in the box.');
  const pointsRef = useRef<Point[]>([]);
  const activePointerRef = useRef<number | null>(null);
  const templatePointsRef = useRef<Point[]>([]);
  const activeTemplatePointerRef = useRef<number | null>(null);
  const fadeTimersRef = useRef<number[]>([]);
  const nextStrokeId = useRef(1);

  const pointFromEvent = (event: ReactPointerEvent<SVGSVGElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * VIEWBOX_WIDTH,
      y: ((event.clientY - rect.top) / rect.height) * VIEWBOX_HEIGHT,
    };
  };

  const templatePointFromEvent = (event: ReactPointerEvent<SVGSVGElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * TEMPLATE_VIEWBOX_WIDTH,
      y: ((event.clientY - rect.top) / rect.height) * TEMPLATE_VIEWBOX_HEIGHT,
    };
  };

  const finishStroke = (points: Point[]) => {
    const wholeRecognition = recognizeCustomStroke(points, customSymbols) ?? recognizeStroke(points);
    const joinedRecognition = wholeRecognition.token ? null : recognizeJoinedStroke(points, customSymbols);
    const segments = joinedRecognition?.segments ?? [{ points, token: wholeRecognition.token }];
    const strokeId = nextStrokeId.current;
    const stroke: Stroke = { id: strokeId, points, segments };
    nextStrokeId.current += 1;
    setStrokes((current) => [...current, stroke]);
    setMarkCount((current) => current + segments.length);
    const timerId = window.setTimeout(() => {
      setStrokes((current) => current.filter((existingStroke) => existingStroke.id !== strokeId));
      fadeTimersRef.current = fadeTimersRef.current.filter((existingTimer) => existingTimer !== timerId);
    }, displayDelay);
    fadeTimersRef.current.push(timerId);
    if (joinedRecognition) {
      setTranslatedText((current) => `${current}${joinedRecognition.segments.map((segment) => segment.token).join('')}`);
      setStatus({ label: joinedRecognition.detail, tone: 'success' });
    } else if (wholeRecognition.token) {
      setTranslatedText((current) => `${current}${wholeRecognition.token}`);
      setStatus({ label: wholeRecognition.detail, tone: 'success' });
    } else {
      setStatus({ label: wholeRecognition.detail, tone: 'ready' });
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (activePointerRef.current !== null || !event.isPrimary) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointerRef.current = event.pointerId;
    const point = pointFromEvent(event);
    pointsRef.current = [point];
    setCurrentStroke([point]);
    setInputMode(event.pointerType === 'pen' ? 'Pencil active' : 'Touch / pointer active');
    setStatus({ label: 'Writing…', tone: 'writing' });
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (activePointerRef.current !== event.pointerId) return;
    event.preventDefault();
    const point = pointFromEvent(event);
    const previous = pointsRef.current[pointsRef.current.length - 1];
    if (previous && distance(previous, point) < 1.5) return;
    pointsRef.current = [...pointsRef.current, point];
    setCurrentStroke(pointsRef.current);
  };

  const handlePointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (activePointerRef.current !== event.pointerId) return;
    event.preventDefault();
    const point = pointFromEvent(event);
    const points = pointsRef.current;
    if (!points.length || distance(points[points.length - 1], point) > 1.5) pointsRef.current = [...points, point];
    const completedPoints = pointsRef.current;
    activePointerRef.current = null;
    pointsRef.current = [];
    setCurrentStroke([]);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (isSpaceTap(completedPoints)) {
      setTranslatedText((current) => current && !current.endsWith(' ') ? `${current} ` : current);
      setStatus({ label: 'Space added to the transcript.', tone: 'success' });
      setInputMode(event.pointerType === 'pen' ? 'Pencil ready' : 'Drawing ready');
      return;
    }
    finishStroke(completedPoints);
    setInputMode(event.pointerType === 'pen' ? 'Pencil ready' : 'Drawing ready');
  };

  const handlePointerCancel = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (activePointerRef.current !== event.pointerId) return;
    activePointerRef.current = null;
    pointsRef.current = [];
    setCurrentStroke([]);
    setInputMode('Pencil ready');
    setStatus({ label: 'Stroke cancelled. Ready when you are.', tone: 'ready' });
  };

  const handleTemplatePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!isTeaching || activeTemplatePointerRef.current !== null || !event.isPrimary) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    activeTemplatePointerRef.current = event.pointerId;
    const point = templatePointFromEvent(event);
    templatePointsRef.current = [point];
    setTemplatePoints([point]);
    setTemplateStatus('Keep drawing, then lift to set the mark.');
  };

  const handleTemplatePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (activeTemplatePointerRef.current !== event.pointerId) return;
    event.preventDefault();
    const point = templatePointFromEvent(event);
    const previous = templatePointsRef.current[templatePointsRef.current.length - 1];
    if (previous && distance(previous, point) < 1.2) return;
    templatePointsRef.current = [...templatePointsRef.current, point];
    setTemplatePoints(templatePointsRef.current);
  };

  const handleTemplatePointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (activeTemplatePointerRef.current !== event.pointerId) return;
    event.preventDefault();
    const point = templatePointFromEvent(event);
    const points = templatePointsRef.current;
    if (!points.length || distance(points[points.length - 1], point) > 1.2) templatePointsRef.current = [...points, point];
    activeTemplatePointerRef.current = null;
    setTemplatePoints(templatePointsRef.current);
    setTemplateStatus(templatePointsRef.current.length >= 3 ? 'Mark captured. Give it a meaning.' : 'That mark was too brief. Draw it again.');
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleTemplatePointerCancel = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (activeTemplatePointerRef.current !== event.pointerId) return;
    activeTemplatePointerRef.current = null;
    templatePointsRef.current = [];
    setTemplatePoints([]);
    setTemplateStatus('Stroke cancelled. Draw one clear mark in the box.');
  };

  const resetTemplate = () => {
    activeTemplatePointerRef.current = null;
    templatePointsRef.current = [];
    setTemplatePoints([]);
    setSymbolLabel('');
    setTemplateStatus('Draw one clear mark in the box.');
  };

  const startTeaching = () => {
    resetTemplate();
    setIsTeaching(true);
  };

  const cancelTeaching = () => {
    resetTemplate();
    setIsTeaching(false);
  };

  const saveSymbol = () => {
    const label = symbolLabel.trim();
    if (!label || templatePoints.length < 3) {
      setTemplateStatus(!label ? 'Add a letter or suffix first.' : 'Draw a mark before saving it.');
      return;
    }
    const savedSymbol: CustomSymbol = { id: Date.now(), label, points: templatePoints };
    const nextSymbols = [savedSymbol, ...customSymbols];
    setCustomSymbols(nextSymbols);
    window.localStorage.setItem(SYMBOL_STORAGE_KEY, JSON.stringify(nextSymbols));
    resetTemplate();
    setIsTeaching(false);
    setStatus({ label: `Saved ${label} to your symbols.`, tone: 'success' });
  };

  const deleteSymbol = (id: number) => {
    const nextSymbols = customSymbols.filter((symbol) => symbol.id !== id);
    setCustomSymbols(nextSymbols);
    window.localStorage.setItem(SYMBOL_STORAGE_KEY, JSON.stringify(nextSymbols));
    setStatus({ label: 'Custom symbol removed.', tone: 'ready' });
  };

  const updateDisplayDelay = (seconds: number) => {
    const nextDelay = Math.round(seconds * 1000);
    setDisplayDelay(nextDelay);
    window.localStorage.setItem(DISPLAY_DELAY_STORAGE_KEY, String(nextDelay));
  };

  const clearCanvas = () => {
    activePointerRef.current = null;
    pointsRef.current = [];
    fadeTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    fadeTimersRef.current = [];
    setCurrentStroke([]);
    setStrokes([]);
    setMarkCount(0);
    setTranslatedText('');
    setStatus({ label: 'Canvas cleared. Ready when you are.', tone: 'ready' });
    setInputMode('Pencil ready');
  };

  return (
    <main className="instrument-app" data-testid="page-pencil-shorthand">
      <header className="topbar">
        <div className="brand" data-testid="text-brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-word">pencil <em>shorthand</em></span>
        </div>
        <div className="topbar-actions">
          <div className={`readiness ${status.tone === 'writing' ? 'is-writing' : ''} ${status.tone === 'success' ? 'is-done' : ''}`} data-testid="status-pencil-readiness">
            <span className="readiness-dot" aria-hidden="true" />
            <span>{inputMode}</span>
          </div>
          <button
            className="symbol-button"
            type="button"
            aria-label="Open my symbols"
            aria-expanded={showSymbols}
            data-testid="button-my-symbols"
            onClick={() => {
              setShowSymbols((current) => !current);
              setShowVocabulary(false);
              setShowSettings(false);
              setIsTeaching(false);
            }}
          >
            <PenLine size={15} strokeWidth={1.7} />
            <span>My symbols</span>
            {customSymbols.length > 0 && <b>{customSymbols.length}</b>}
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label={showVocabulary ? 'Close shorthand vocabulary' : 'Open shorthand vocabulary'}
            aria-expanded={showVocabulary}
            data-testid="button-vocabulary"
            onClick={() => {
              setShowVocabulary((current) => !current);
              setShowSymbols(false);
              setShowSettings(false);
              setIsTeaching(false);
            }}
          >
            <CircleHelp size={17} strokeWidth={1.6} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label={showSettings ? 'Close settings' : 'Open settings'}
            aria-expanded={showSettings}
            data-testid="button-settings"
            onClick={() => {
              setShowSettings((current) => !current);
              setShowVocabulary(false);
              setShowSymbols(false);
              setIsTeaching(false);
            }}
          >
            <Settings2 size={16} strokeWidth={1.7} />
          </button>
        </div>
      </header>

      <section className="workspace" aria-label="Shorthand writing canvas">
        <div className="canvas-legend" aria-hidden="true">
          <div className="eyebrow">A quiet translation desk</div>
          <h1>Think in marks.<br />Read in words.</h1>
          <p>Draw a word as one joined stroke. Sharp turns split it into symbols as its meaning joins the line below.</p>
          <div className="rule" />
        </div>

        <svg
          className="drawing-surface"
          viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Interactive shorthand drawing canvas"
          data-testid="canvas-drawing-surface"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
        >
          <defs>
            <filter id="inkTexture">
              <feTurbulence type="fractalNoise" baseFrequency=".65" numOctaves="2" seed="7" result="noise" />
              <feDisplacementMap in="SourceGraphic" in2="noise" scale=".65" />
            </filter>
          </defs>
          <g opacity=".8">
            {Array.from({ length: 9 }, (_, index) => (
              <line
                key={`guide-${index}`}
                x1="0"
                y1={145 + index * 92}
                x2={VIEWBOX_WIDTH}
                y2={145 + index * 92}
                stroke="rgba(85, 100, 99, .12)"
                strokeWidth="1"
                strokeDasharray="2 16"
              />
            ))}
          </g>
          <g className="writing-guides" aria-hidden="true">
            <line x1="0" y1={WRITING_LINE_TOP} x2={VIEWBOX_WIDTH} y2={WRITING_LINE_TOP} />
            <line x1="0" y1={WRITING_LINE_BOTTOM} x2={VIEWBOX_WIDTH} y2={WRITING_LINE_BOTTOM} />
            <text x="38" y={WRITING_LINE_TOP - 12}>upper line</text>
            <text x="38" y={WRITING_LINE_BOTTOM + 24}>baseline</text>
          </g>
          {strokes.map((stroke) => (
            <g key={stroke.id} data-testid={`group-stroke-${stroke.id}`}>
              {stroke.segments.map((segment, segmentIndex) => {
                const lastPoint = segment.points[segment.points.length - 1];
                const suffix = segmentIndex === 0 ? '' : `-${segmentIndex + 1}`;
                return (
                  <g key={`${stroke.id}-${segmentIndex}`}>
                    <path
                      className={`stroke ${segment.token ? '' : 'ambiguous'}`}
                      d={pathFromPoints(segment.points)}
                      data-testid={`path-stroke-${stroke.id}${suffix}`}
                    />
                    {segment.token && (
                      <text className="token-mark" x={lastPoint.x + 12} y={lastPoint.y - 12} data-testid={`text-token-${stroke.id}${suffix}`}>
                        {segment.token}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          ))}
          {currentStroke.length > 0 && <path className="active-stroke" d={pathFromPoints(currentStroke)} data-testid="path-active-stroke" />}
        </svg>

        <div className="canvas-helper">
          <PencilGlyph />
          <span>Join symbols · sharp turns split the word</span>
        </div>
        <div className="space-tap-hint" aria-hidden="true">
          <span className="space-tap-dot" />
          <span>Tap here for a space</span>
        </div>

        {showVocabulary && (
          <aside className="vocabulary-card" data-testid="panel-vocabulary">
            <div className="vocabulary-header">
              <div>
                <h2>Small vocabulary</h2>
                <p>Four marks to get you moving.</p>
              </div>
              <Info size={16} color="var(--signal)" strokeWidth={1.7} aria-hidden="true" />
            </div>
            <div className="rule-list">
              <RuleItem token="M" title="Move across" detail="Straight, left to right · 60 px+" />
              <RuleItem token="-ing" title="Keep going" detail="Short, upward stroke · 50 px+" />
              <RuleItem token="E" title="Enclose" detail="Closed loop or circle" />
              <RuleItem token="T" title="Turn down" detail="Top-left to bottom-right diagonal" />
            </div>
          </aside>
        )}

        {showSymbols && (
          <aside className="symbols-card" data-testid="panel-my-symbols">
            <div className="symbols-header">
              <div>
                <div className="eyebrow">Personal vocabulary</div>
                <h2>My symbols</h2>
                <p>Teach the page a mark of your own.</p>
              </div>
              <button className="panel-close" type="button" aria-label="Close my symbols" onClick={() => setShowSymbols(false)} data-testid="button-close-my-symbols">
                <X size={16} strokeWidth={1.7} />
              </button>
            </div>

            {isTeaching ? (
              <div className="symbol-trainer">
                <label className="meaning-field">
                  <span>What should this become?</span>
                  <input
                    value={symbolLabel}
                    onChange={(event) => setSymbolLabel(event.target.value)}
                    placeholder="letter or suffix, e.g. th"
                    maxLength={18}
                    autoFocus
                    data-testid="input-symbol-meaning"
                  />
                </label>
                <svg
                  className="template-surface"
                  viewBox={`0 0 ${TEMPLATE_VIEWBOX_WIDTH} ${TEMPLATE_VIEWBOX_HEIGHT}`}
                  role="img"
                  aria-label="Draw a new symbol"
                  data-testid="canvas-symbol-template"
                  onPointerDown={handleTemplatePointerDown}
                  onPointerMove={handleTemplatePointerMove}
                  onPointerUp={handleTemplatePointerUp}
                  onPointerCancel={handleTemplatePointerCancel}
                >
                  <line x1="0" y1={TEMPLATE_LINE_TOP} x2={TEMPLATE_VIEWBOX_WIDTH} y2={TEMPLATE_LINE_TOP} className="template-guide" />
                  <line x1="0" y1={TEMPLATE_LINE_BOTTOM} x2={TEMPLATE_VIEWBOX_WIDTH} y2={TEMPLATE_LINE_BOTTOM} className="template-guide" />
                  <text x="12" y={TEMPLATE_LINE_TOP - 9} className="template-guide-label">upper</text>
                  <text x="12" y={TEMPLATE_LINE_BOTTOM + 17} className="template-guide-label">baseline</text>
                  {templatePoints.length > 0 && <path className="template-stroke" d={pathFromPoints(templatePoints)} data-testid="path-symbol-template" />}
                </svg>
                <p className={`template-status ${templatePoints.length >= 3 ? 'is-captured' : ''}`}>{templateStatus}</p>
                <div className="trainer-actions">
                  <button className="quiet-button" type="button" onClick={cancelTeaching} data-testid="button-cancel-symbol">
                    Cancel
                  </button>
                  <button className="save-button" type="button" onClick={saveSymbol} disabled={!symbolLabel.trim() || templatePoints.length < 3} data-testid="button-save-symbol">
                    <Save size={14} strokeWidth={1.8} />
                    Save symbol
                  </button>
                </div>
              </div>
            ) : (
              <>
                {customSymbols.length > 0 ? (
                  <div className="custom-symbol-list">
                    {customSymbols.map((symbol) => (
                      <div className="custom-symbol-row" key={symbol.id} data-testid={`custom-symbol-${symbol.id}`}>
                        <svg className="custom-symbol-preview" viewBox={`0 0 ${TEMPLATE_VIEWBOX_WIDTH} ${TEMPLATE_VIEWBOX_HEIGHT}`} aria-hidden="true">
                          <path d={pathFromPoints(symbol.points)} />
                        </svg>
                        <div className="custom-symbol-copy">
                          <strong>{symbol.label}</strong>
                          <span>{positionLabel(symbol.points)} · custom mark</span>
                        </div>
                        <button className="delete-symbol" type="button" aria-label={`Remove symbol ${symbol.label}`} onClick={() => deleteSymbol(symbol.id)} data-testid={`button-delete-symbol-${symbol.id}`}>
                          <Trash2 size={14} strokeWidth={1.7} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="symbols-empty">
                    <PenLine size={18} strokeWidth={1.6} />
                    <p>No personal symbols yet.</p>
                    <span>Save a mark for a name, letter, or suffix you use often.</span>
                  </div>
                )}
                <button className="teach-button" type="button" onClick={startTeaching} data-testid="button-teach-symbol">
                  <Plus size={15} strokeWidth={1.8} />
                  Teach a new symbol
                </button>
              </>
            )}
          </aside>
        )}

        {showSettings && (
          <aside className="settings-card" data-testid="panel-settings">
            <div className="settings-header">
              <div>
                <div className="eyebrow">Writing preferences</div>
                <h2>Settings</h2>
                <p>Keep the desk clear while you keep thinking.</p>
              </div>
              <button className="panel-close" type="button" aria-label="Close settings" onClick={() => setShowSettings(false)} data-testid="button-close-settings">
                <X size={16} strokeWidth={1.7} />
              </button>
            </div>
            <div className="setting-block">
              <div className="setting-label">
                <div>
                  <strong>Mark visibility</strong>
                  <span>Completed marks fade from the canvas after this delay.</span>
                </div>
                <b>{formatDuration(displayDelay)}</b>
              </div>
              <input
                className="delay-slider"
                type="range"
                min=".1"
                max="3"
                step=".1"
                value={displayDelay / 1000}
                onChange={(event) => updateDisplayDelay(Number(event.target.value))}
                aria-label="Seconds before completed marks disappear"
                data-testid="slider-display-delay"
              />
              <div className="slider-scale" aria-hidden="true">
                <span>0.1 sec</span>
                <span>3 sec</span>
              </div>
            </div>
          </aside>
        )}
      </section>

      <div className={`status-line ${status.tone}`} aria-live="polite" data-testid="status-recognition">
        {statusIcon(status.tone)}
        <span>{status.label}</span>
      </div>

      <footer className="translation-bar" data-testid="translation-bar">
        <div className="translation-label">
          <span className="signal-bar" aria-hidden="true" />
          <div>
            <strong>Translated text</strong>
            <span>{markCount} {markCount === 1 ? 'mark' : 'marks'} written</span>
          </div>
        </div>
        <div className={`translation-output ${translatedText ? '' : 'is-empty'}`} aria-live="polite" data-testid="text-translated-output">
          {translatedText || 'Your words will gather here'}
        </div>
        <div className="translation-actions">
          <button className="clear-button" type="button" onClick={clearCanvas} data-testid="button-clear-canvas">
            <RotateCcw size={14} strokeWidth={1.8} />
            <span>Clear canvas</span>
          </button>
        </div>
      </footer>
    </main>
  );
}

function RuleItem({ token, title, detail }: { token: string; title: string; detail: string }) {
  return (
    <div className="rule-item" data-testid={`rule-${token}`}>
      <div className="rule-token">{token}</div>
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
    </div>
  );
}

function PencilGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path d="M3.2 11.8 3.8 9l5.9-5.9 2.2 2.2L6 11.2l-2.8.6Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="m8.7 4.1 2.2 2.2M3.1 11.9l-1 .9" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;