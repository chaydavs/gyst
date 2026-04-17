import { useEffect, useRef, useState, useCallback } from 'react';

interface GraphNode {
  id: string;
  type: string;
  title: string;
  layer: 'curated' | 'structural';
  // physics state (mutated in place — intentional, this is simulation state)
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

interface GraphEdge {
  source: string;
  target: string;
  strength: number;
  layer: 'curated' | 'structural';
}

interface GraphData {
  nodes: Array<{ id: string; type: string; title: string; layer?: string }>;
  edges: Array<{ source: string; target: string; strength?: number; layer?: string }>;
}

interface GraphCanvasProps {
  onNodeClick: (id: string) => void;
  refreshKey?: number;
}

// Monochrome-friendly type shades — enough visual distinction without color
const TYPE_SHADE: Record<string, string> = {
  ghost_knowledge: '#111',
  error_pattern:  '#444',
  decision:       '#666',
  convention:     '#888',
  learning:       '#aaa',
  structural:     '#ccc',
};

const REPULSION   = 2000;
const SPRING_K    = 0.04;
const SPRING_LEN  = 120;
const DAMPING     = 0.82;
const CENTER_PULL = 0.006;

function runPhysics(nodes: GraphNode[], edges: GraphEdge[], width: number, height: number) {
  const cx = width / 2;
  const cy = height / 2;

  // Repulsion
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist2 = dx * dx + dy * dy + 1;
      const dist  = Math.sqrt(dist2);
      const force = REPULSION / dist2;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx -= fx; a.vy -= fy;
      b.vx += fx; b.vy += fy;
    }
  }

  // Spring attraction along edges
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  for (const edge of edges) {
    const a = nodeMap.get(edge.source);
    const b = nodeMap.get(edge.target);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const stretch = dist - SPRING_LEN;
    const force = stretch * SPRING_K * (edge.strength ?? 1);
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    a.vx += fx; a.vy += fy;
    b.vx -= fx; b.vy -= fy;
  }

  // Center pull + integrate + damp
  for (const n of nodes) {
    n.vx += (cx - n.x) * CENTER_PULL;
    n.vy += (cy - n.y) * CENTER_PULL;
    n.vx *= DAMPING;
    n.vy *= DAMPING;
    n.x += n.vx;
    n.y += n.vy;
  }
}

function drawGraph(
  ctx: CanvasRenderingContext2D,
  nodes: GraphNode[],
  edges: GraphEdge[],
  hoveredId: string | null,
  width: number,
  height: number,
) {
  ctx.clearRect(0, 0, width, height);

  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const connectedIds = new Set<string>();
  if (hoveredId) {
    for (const e of edges) {
      if (e.source === hoveredId) connectedIds.add(e.target);
      if (e.target === hoveredId) connectedIds.add(e.source);
    }
  }

  // Draw edges
  for (const edge of edges) {
    const a = nodeMap.get(edge.source);
    const b = nodeMap.get(edge.target);
    if (!a || !b) continue;
    const isActive = hoveredId && (edge.source === hoveredId || edge.target === hoveredId);
    const isStructural = edge.layer === 'structural';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = isActive ? '#000' : (isStructural ? '#eee' : '#ddd');
    ctx.lineWidth = isActive ? 1.5 : (isStructural ? 0.5 : 1);
    if (isStructural && !isActive) {
      ctx.setLineDash([2, 4]);
    } else {
      ctx.setLineDash([]);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Draw nodes
  for (const node of nodes) {
    const isHovered = node.id === hoveredId;
    const isConnected = connectedIds.has(node.id);
    const isDimmed = hoveredId && !isHovered && !isConnected;
    const shade = node.layer === 'structural' ? '#ccc' : (TYPE_SHADE[node.type] ?? '#888');
    const fill = isDimmed ? '#ebebeb' : (isHovered ? '#000' : shade);

    if (node.layer === 'structural') {
      // Structural nodes (Graphify code graph): small squares
      const s = node.radius;
      ctx.fillStyle = fill;
      ctx.fillRect(node.x - s / 2, node.y - s / 2, s, s);
      if (isHovered) {
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(node.x - s / 2, node.y - s / 2, s, s);
      }
    } else {
      // Knowledge entries: circles
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      if (isHovered) {
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  // Draw label for hovered node
  if (hoveredId) {
    const node = nodeMap.get(hoveredId);
    if (node) {
      const label = node.title.length > 40 ? node.title.slice(0, 38) + '…' : node.title;
      const px = 10;
      const py = 13;
      ctx.font = '12px "Helvetica Neue", Helvetica, Arial, sans-serif';
      const w = ctx.measureText(label).width + px * 2;
      // Position tooltip near node but keep it in bounds
      let tx = node.x + 14;
      let ty = node.y - 8;
      if (tx + w > width - 8) tx = node.x - w - 14;
      if (ty - py < 4) ty = node.y + 20;

      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.roundRect(tx, ty - py, w, 24, 4);
      ctx.fill();

      ctx.fillStyle = '#fff';
      ctx.fillText(label, tx + px, ty + 3);
    }
  }
}

export default function GraphCanvas({ onNodeClick, refreshKey }: GraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef  = useRef<GraphNode[]>([]);
  const edgesRef  = useRef<GraphEdge[]>([]);
  const rafRef    = useRef<number>(0);
  const hoveredRef = useRef<string | null>(null);
  const dragRef   = useRef<{ id: string; ox: number; oy: number } | null>(null);

  const [loading, setLoading] = useState(true);
  const [nodeCount, setNodeCount] = useState(0);
  const [edgeCount, setEdgeCount] = useState(0);

  // Load graph data
  useEffect(() => {
    setLoading(true);
    fetch('/api/graph')
      .then(r => r.json())
      .then((data: GraphData) => {
        const canvas = canvasRef.current;
        const w = canvas?.offsetWidth ?? 800;
        const h = canvas?.offsetHeight ?? 600;

        nodesRef.current = data.nodes.map(n => ({
          id: n.id,
          type: n.type,
          title: n.title,
          layer: (n.layer === 'structural' ? 'structural' : 'curated') as 'curated' | 'structural',
          x: w / 2 + (Math.random() - 0.5) * 300,
          y: h / 2 + (Math.random() - 0.5) * 300,
          vx: 0,
          vy: 0,
          radius: n.layer === 'structural' ? 4 : 8,
        }));
        edgesRef.current = data.edges.map(e => ({
          source: e.source,
          target: e.target,
          strength: e.strength ?? 1,
          layer: (e.layer === 'structural' ? 'structural' : 'curated') as 'curated' | 'structural',
        }));
        setNodeCount(data.nodes.length);
        setEdgeCount(data.edges.length);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [refreshKey]);

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let running = true;
    let frame = 0;

    const loop = () => {
      if (!running) return;
      const w = canvas.width;
      const h = canvas.height;

      // Run physics for first 300 frames (settle), then slow down
      if (frame < 300 || frame % 2 === 0) {
        runPhysics(nodesRef.current, edgesRef.current, w, h);
      }
      drawGraph(ctx, nodesRef.current, edgesRef.current, hoveredRef.current, w, h);
      frame++;
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [loading]);

  // Resize observer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const obs = new ResizeObserver(() => {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
    });
    obs.observe(canvas);
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    return () => obs.disconnect();
  }, []);

  const getNodeAtPoint = useCallback((cx: number, cy: number): GraphNode | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = cx - rect.left;
    const my = cy - rect.top;
    for (const n of nodesRef.current) {
      const dx = n.x - mx;
      const dy = n.y - my;
      if (dx * dx + dy * dy <= (n.radius + 4) * (n.radius + 4)) return n;
    }
    return null;
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragRef.current) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const node = nodesRef.current.find(n => n.id === dragRef.current!.id);
      if (node) {
        node.x = e.clientX - rect.left;
        node.y = e.clientY - rect.top;
        node.vx = 0;
        node.vy = 0;
      }
      return;
    }
    const node = getNodeAtPoint(e.clientX, e.clientY);
    hoveredRef.current = node?.id ?? null;
    if (canvasRef.current) {
      canvasRef.current.style.cursor = node ? 'pointer' : 'default';
    }
  }, [getNodeAtPoint]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const node = getNodeAtPoint(e.clientX, e.clientY);
    if (node) {
      dragRef.current = { id: node.id, ox: e.clientX - node.x, oy: e.clientY - node.y };
    }
  }, [getNodeAtPoint]);

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const handleClick = useCallback((e: React.MouseEvent) => {
    const node = getNodeAtPoint(e.clientX, e.clientY);
    if (node && node.type !== 'structural') {
      onNodeClick(node.id);
    }
  }, [getNodeAtPoint, onNodeClick]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#fff' }}>
      {/* Legend */}
      <div
        style={{
          position: 'absolute',
          top: '16px',
          left: '16px',
          zIndex: 2,
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          background: 'rgba(255,255,255,0.94)',
          border: '1px solid var(--line)',
          borderRadius: '4px',
          padding: '10px 12px',
          minWidth: '148px',
        }}
      >
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '9px', color: '#bbb', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '2px' }}>Knowledge</span>
        {Object.entries(TYPE_SHADE).map(([type, shade]) => (
          <div key={type} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: shade, flexShrink: 0 }} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: '#666', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {type.replace(/_/g, ' ')}
            </span>
          </div>
        ))}
        <div style={{ height: '1px', background: 'var(--line)', margin: '4px 0 2px' }} />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '9px', color: '#bbb', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '2px' }}>Code graph (Graphify)</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ width: '8px', height: '8px', background: '#ccc', flexShrink: 0 }} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: '#666', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            file / function
          </span>
        </div>
        <div style={{ height: '1px', background: 'var(--line)', margin: '4px 0 2px' }} />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: '#999' }}>
          {nodeCount} nodes · {edgeCount} edges
        </span>
      </div>

      {/* Hint */}
      <div
        style={{
          position: 'absolute',
          bottom: '16px',
          left: '50%',
          transform: 'translateX(-50%)',
          fontFamily: 'var(--font-mono)',
          fontSize: '10px',
          color: '#bbb',
          pointerEvents: 'none',
          letterSpacing: '0.04em',
        }}
      >
        hover to label · click to open · drag to reposition
      </div>

      {loading && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'var(--font-mono)',
            fontSize: '12px',
            color: '#bbb',
          }}
        >
          Loading graph…
        </div>
      )}

      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%' }}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleClick}
      />
    </div>
  );
}
