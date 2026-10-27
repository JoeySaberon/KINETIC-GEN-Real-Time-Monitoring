package com.piezopower.tracker;

import android.content.Context;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "TabHaptics")
public class TabHapticsPlugin extends Plugin {
	@PluginMethod
	public void tick(PluginCall call) {
		getActivity().runOnUiThread(() -> {
			try {
				Vibrator vibrator = (Vibrator) getContext()
						.getSystemService(Context.VIBRATOR_SERVICE);
				if (vibrator == null || !vibrator.hasVibrator()) {
					call.reject("This device does not have a vibrator.");
					return;
				}

				boolean supportsClickEffect =
						Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
						vibrator.areEffectsSupported(VibrationEffect.EFFECT_CLICK)[0] ==
								Vibrator.VIBRATION_EFFECT_SUPPORT_YES;
				if (supportsClickEffect) {
					vibrator.vibrate(
							VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK)
					);
				} else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
					vibrator.vibrate(VibrationEffect.createOneShot(
							35,
							VibrationEffect.DEFAULT_AMPLITUDE
					));
				} else {
					vibrator.vibrate(35);
				}
				call.resolve();
			} catch (RuntimeException error) {
				call.reject("Unable to trigger tab haptic feedback: " + error.getMessage());
			}
		});
	}
}
