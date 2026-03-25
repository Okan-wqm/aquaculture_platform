import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { CheckCircle2, XCircle, Tag } from 'lucide-react';
import { useDeviceTags, TagInfo } from '../../../hooks/useDeviceTags';
import { FunctionReference } from './FunctionReference';
import {
  extractDependencies,
  validateExpression,
  tryEvaluate,
  getTagAutocompleteContext,
  ValidationResult,
} from './expressionUtils';

interface ExpressionEditorProps {
  /** Current expression string */
  expression: string;
  /** Called when expression changes */
  onChange: (expression: string) => void;
  /** Device ID for tag autocomplete */
  deviceId?: string | null;
  /** Current tag values for live preview */
  tagValues?: Record<string, number | string | boolean>;
  /** Placeholder text */
  placeholder?: string;
}

/**
 * Rich expression editor for computed tag values. Uses a standard textarea
 * (not Monaco/CodeMirror) for small bundle size. Provides tag autocomplete
 * on `${`, debounced validation, and live evaluation preview. Fully
 * controlled -- receives expression string and onChange from the parent.
 */
export const ExpressionEditor: React.FC<ExpressionEditorProps> = ({
  expression,
  onChange,
  deviceId = null,
  tagValues,
  placeholder = '${temperature} * 1.8 + 32',
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [livePreview, setLivePreview] = useState<string | null>(null);
  const [autocompleteOpen, setAutocompleteOpen] = useState(false);
  const [autocompleteFilter, setAutocompleteFilter] = useState('');
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const { tags } = useDeviceTags(deviceId);

  const filteredTags = useMemo<TagInfo[]>(() => {
    if (!autocompleteFilter && !autocompleteOpen) return tags;
    const term = autocompleteFilter.toLowerCase();
    return tags.filter(
      (t) =>
        t.name.toLowerCase().includes(term) ||
        (t.description && t.description.toLowerCase().includes(term)),
    );
  }, [tags, autocompleteFilter, autocompleteOpen]);

  const dependencies = useMemo(() => extractDependencies(expression), [expression]);

  useEffect(() => {
    if (!expression.trim()) {
      setValidation(null);
      setLivePreview(null);
      return;
    }

    const timer = setTimeout(() => {
      const result = validateExpression(expression);
      setValidation(result);

      if (result.valid && tagValues && Object.keys(tagValues).length > 0) {
        const evalResult = tryEvaluate(expression, tagValues);
        setLivePreview(evalResult.value);
      } else {
        setLivePreview(null);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [expression, tagValues]);

  const checkAutocomplete = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const context = getTagAutocompleteContext(textarea.value, textarea.selectionStart);
    if (context !== null) {
      setAutocompleteOpen(true);
      setAutocompleteFilter(context);
      setAutocompleteIndex(0);
    } else {
      setAutocompleteOpen(false);
      setAutocompleteFilter('');
    }
  }, []);

  const insertTag = useCallback(
    (tagName: string) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const cursorPos = textarea.selectionStart;
      const before = textarea.value.slice(0, cursorPos);
      const after = textarea.value.slice(cursorPos);

      const lastOpen = before.lastIndexOf('${');
      const prefix = before.slice(0, lastOpen + 2);
      const newValue = `${prefix}${tagName}}${after}`;
      onChange(newValue);
      setAutocompleteOpen(false);

      requestAnimationFrame(() => {
        const newPos = prefix.length + tagName.length + 1;
        textarea.focus();
        textarea.setSelectionRange(newPos, newPos);
      });
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!autocompleteOpen) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        setAutocompleteOpen(false);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        if (filteredTags.length > 0) {
          e.preventDefault();
          insertTag(filteredTags[autocompleteIndex].name);
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAutocompleteIndex((prev) => Math.min(prev + 1, filteredTags.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAutocompleteIndex((prev) => Math.max(prev - 1, 0));
      }
    },
    [autocompleteOpen, filteredTags, autocompleteIndex, insertTag],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
      requestAnimationFrame(checkAutocomplete);
    },
    [onChange, checkAutocomplete],
  );

  return (
    <div className="space-y-1.5">
      <div className="relative">
        <textarea
          ref={textareaRef}
          data-testid="expression-textarea"
          value={expression}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onSelect={checkAutocomplete}
          placeholder={placeholder}
          rows={3}
          spellCheck={false}
          className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded-lg resize-y focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
        <div className="absolute top-2 right-2">
          <FunctionReference />
        </div>

        {autocompleteOpen && filteredTags.length > 0 && (
          <div
            data-testid="tag-autocomplete-dropdown"
            className="absolute z-50 mt-0.5 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-40 overflow-y-auto"
          >
            {filteredTags.map((tag, idx) => (
              <button
                key={tag.name}
                type="button"
                onClick={() => insertTag(tag.name)}
                className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 transition-colors ${
                  idx === autocompleteIndex ? 'bg-cyan-50 text-cyan-700' : 'hover:bg-gray-50'
                }`}
              >
                <Tag className="w-3 h-3 text-gray-400 shrink-0" />
                <span className="font-mono font-medium truncate">{tag.name}</span>
                {tag.unit && <span className="text-xs text-gray-400 ml-auto">{tag.unit}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {validation && (
        <div
          data-testid="expression-validation"
          className={`flex items-center gap-1.5 text-xs ${
            validation.valid ? 'text-green-600' : 'text-red-500'
          }`}
        >
          {validation.valid ? (
            <>
              <CheckCircle2 className="w-3.5 h-3.5" data-testid="validation-valid" />
              <span>Valid expression</span>
            </>
          ) : (
            <>
              <XCircle className="w-3.5 h-3.5" data-testid="validation-invalid" />
              <span>{validation.error}</span>
              {validation.position !== undefined && (
                <span className="text-gray-400 ml-1">(pos {validation.position})</span>
              )}
            </>
          )}
        </div>
      )}

      {livePreview !== null && validation?.valid && (
        <div
          data-testid="expression-preview"
          className="flex items-center gap-1.5 text-xs text-gray-600 bg-gray-50 rounded px-2 py-1"
        >
          <span className="text-gray-400">Result:</span>
          <span className="font-mono font-semibold">{livePreview}</span>
        </div>
      )}

      {dependencies.length > 0 && (
        <div data-testid="expression-dependencies" className="flex flex-wrap gap-1">
          {dependencies.map((dep) => (
            <span
              key={dep}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono font-medium bg-cyan-50 text-cyan-700 border border-cyan-200 rounded"
            >
              <Tag className="w-2.5 h-2.5" />
              {dep}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};
