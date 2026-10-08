/**
 * What a parameter records — its measured quantity — declared or cleared on
 * its own write (declareParameterQuantity / clearParameterQuantity), not with
 * the form's save: a declaration is history the backend keeps, with who and
 * when. Fixed while a sensor channel is bound to the parameter (the backend
 * refuses with PARAMETER_BOUND); the field says so instead of offering it.
 */
import {
  bindingRefusal,
  errorText,
  quantityLabel,
  Select,
  useCanMutate,
  useI18n,
} from '@aquaculture/shared-ui';
import React from 'react';

import {
  useClearParameterQuantity,
  useDeclareParameterQuantity,
  useParameterQuantityState,
} from '../../../hooks/useParameterSources';

/** The option that clears a declaration, so the code's own meaning stands. */
const CODE_MEANING = '';

export const MeasuredQuantityField: React.FC<{ parameterConfigId: string }> = ({
  parameterConfigId,
}) => {
  const { t } = useI18n();
  const canDeclare = useCanMutate('declareParameterQuantity');
  const canClear = useCanMutate('clearParameterQuantity');
  const state = useParameterQuantityState(parameterConfigId);
  const declare = useDeclareParameterQuantity();
  const clear = useClearParameterQuantity();

  if (state.data === undefined || state.data === null) {
    return state.error === null ? null : (
      <p className="text-sm text-error-700 dark:text-error-300">{state.error.message}</p>
    );
  }
  const config = state.data;
  if (config.declarableQuantities.length === 0) {
    return (
      <div className="text-sm text-gray-600 dark:text-gray-400">
        Measured quantity: {config.quantity === null ? 'none' : quantityLabel(config.quantity)}
      </div>
    );
  }
  const bound = config.liveChannelSourceCount > 0;
  const writeError = declare.error ?? clear.error;
  const refusal = writeError === null ? null : bindingRefusal(writeError);

  const change = async (next: string): Promise<void> => {
    try {
      if (next === CODE_MEANING) await clear.mutateAsync(config.id);
      else await declare.mutateAsync({ parameterConfigId: config.id, quantity: next });
    } catch {
      // Shown below by its stable code.
    }
  };

  return (
    <div>
      <Select
        label={t('wqSource.ui.measuredQuantity')}
        value={config.declaredQuantity ?? CODE_MEANING}
        disabled={bound || !(canDeclare && canClear) || declare.isPending || clear.isPending}
        onChange={(event) => void change(event.target.value)}
        options={[
          {
            value: CODE_MEANING,
            label:
              config.quantityFamily === null
                ? `As the code '${config.code}' says`
                : `Not declared ('${config.code}' names the ${config.quantityFamily} family)`,
          },
          ...config.declarableQuantities.map((quantity) => ({
            value: quantity,
            label: quantityLabel(quantity),
          })),
        ]}
        helperText={
          bound
            ? `${t('wqSource.error.PARAMETER_BOUND')} (${config.liveChannelSourceCount} bound).`
            : 'Channels can feed this parameter only when they measure exactly this quantity.'
        }
      />
      {writeError !== null && (
        <p role="alert" className="mt-1 text-sm text-error-700 dark:text-error-300">
          {refusal === null ? writeError.message : errorText(t, refusal.code)}
        </p>
      )}
    </div>
  );
};
