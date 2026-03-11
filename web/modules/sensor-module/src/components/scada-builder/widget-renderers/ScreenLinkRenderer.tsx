/**
 * ScreenLinkRenderer - Cross-scene navigation widget
 *
 * Shows a clickable link/button/card that navigates to another SCADA screen.
 * Supports three visual styles: card (default), button, and minimal.
 */

import React, { memo, useCallback } from 'react';
import { ArrowRight, ExternalLink, Monitor } from 'lucide-react';
import type { WidgetRendererProps } from '../WidgetRenderer';

const ICON_MAP: Record<string, typeof ArrowRight> = {
  ArrowRight,
  ExternalLink,
  Monitor,
};

const ScreenLinkRenderer: React.FC<WidgetRendererProps> = ({ config, width, height, isEditing, onCommand }) => {
  const targetScreenId = config.targetScreenId as string | undefined;
  const label = (config.label ?? 'Ekrana Git') as string;
  const iconName = (config.icon ?? 'ArrowRight') as string;
  const style = (config.style ?? 'card') as 'button' | 'card' | 'minimal';
  const color = (config.color ?? '#06b6d4') as string;

  const IconComponent = ICON_MAP[iconName] ?? ArrowRight;
  const hasTarget = Boolean(targetScreenId);

  const handleClick = useCallback(() => {
    if (isEditing || !hasTarget) return;
    onCommand?.('navigate', targetScreenId);
  }, [isEditing, hasTarget, onCommand, targetScreenId]);

  const fontSize = Math.max(10, Math.min(width * 0.09, height * 0.15, 16));
  const iconSize = Math.max(14, Math.min(width * 0.12, height * 0.2, 24));

  /* ---- No target placeholder ---- */
  if (!hasTarget) {
    return (
      <div
        style={{
          width,
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 8,
          boxSizing: 'border-box',
        }}
      >
        <span style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic', textAlign: 'center' }}>
          Hedef ekran secin
        </span>
      </div>
    );
  }

  /* ---- Card style (default) ---- */
  if (style === 'card') {
    return (
      <div
        onClick={handleClick}
        style={{
          width,
          height,
          padding: 10,
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          background: '#ffffff',
          border: `1.5px solid ${color}`,
          borderRadius: 8,
          cursor: isEditing ? 'default' : 'pointer',
          transition: 'box-shadow 0.15s, background 0.15s',
        }}
        onMouseEnter={(e) => {
          if (!isEditing) {
            e.currentTarget.style.boxShadow = `0 2px 8px ${color}33`;
            e.currentTarget.style.background = `${color}08`;
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.boxShadow = 'none';
          e.currentTarget.style.background = '#ffffff';
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
          <IconComponent size={iconSize} color={color} />
          <span
            style={{
              fontSize,
              fontWeight: 600,
              color: '#1f2937',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {label}
          </span>
        </div>
        <ArrowRight size={iconSize * 0.75} color={color} />
      </div>
    );
  }

  /* ---- Button style ---- */
  if (style === 'button') {
    return (
      <div
        style={{
          width,
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 8,
          boxSizing: 'border-box',
        }}
      >
        <div
          onClick={handleClick}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            padding: '6px 16px',
            background: color,
            borderRadius: 6,
            cursor: isEditing ? 'default' : 'pointer',
            boxShadow: '0 2px 4px rgba(0,0,0,0.15)',
            transition: 'opacity 0.15s',
            maxWidth: width - 16,
          }}
          onMouseEnter={(e) => {
            if (!isEditing) e.currentTarget.style.opacity = '0.85';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = '1';
          }}
        >
          <IconComponent size={iconSize * 0.85} color="#ffffff" />
          <span
            style={{
              fontSize,
              fontWeight: 600,
              color: '#ffffff',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {label}
          </span>
        </div>
      </div>
    );
  }

  /* ---- Minimal style ---- */
  return (
    <div
      onClick={handleClick}
      style={{
        width,
        height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: 8,
        boxSizing: 'border-box',
        cursor: isEditing ? 'default' : 'pointer',
      }}
      onMouseEnter={(e) => {
        if (!isEditing) e.currentTarget.style.opacity = '0.7';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.opacity = '1';
      }}
    >
      <span
        style={{
          fontSize,
          fontWeight: 500,
          color,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {label}
      </span>
      <ArrowRight size={iconSize * 0.75} color={color} />
    </div>
  );
};

ScreenLinkRenderer.displayName = 'ScreenLinkRenderer';
export default memo(ScreenLinkRenderer);
