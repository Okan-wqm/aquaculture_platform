/**
 * AdvisoryChip — marks a surface as a model's estimate, not a measurement.
 *
 * ORPHAN-MEDIUM-589. Before v4 the AI cards were distinguished from measured
 * data by purple/indigo chrome. v4 has no purple token — teal is reserved for
 * actions, and the gradients went for sunlight contrast — so the conversion
 * necessarily removed the only signal these cards had.
 *
 * That matters most on the unit detail, where the three AI cards now sit
 * directly beneath LiveReadingsCard's MEASURED sensor values with nothing but a
 * heading between them. A worker acting on a 30-day forecast in the belief that
 * it is a reading is the failure this exists to prevent.
 *
 * The marker is deliberately NOT colour. A colourblind worker must read the
 * same thing everyone else does, so it is a word plus the `~` that the v4
 * design itself puts in front of predicted numerals (`~{{ aiTankScore }}`).
 * Use BOTH: the chip labels the card, the tilde labels the number — a number
 * screenshotted or read aloud on its own still carries its own caveat.
 */
import { type ReactElement } from 'react';

export function AdvisoryChip(): ReactElement {
  return (
    <span className="inline-flex items-center h-6 px-2 rounded-full border border-line bg-surface-2 text-meta font-semibold text-ink-3 shrink-0">
      Advisory
    </span>
  );
}

/**
 * The tilde a predicted numeral wears. A component rather than a literal so the
 * convention is greppable and cannot drift into `≈`, `~ ` or nothing at all.
 */
export function Approx(): ReactElement {
  return (
    <span aria-hidden className="text-ink-3">
      ~
    </span>
  );
}
