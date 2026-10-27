package com.piezopower.tracker;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.Window;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
	@Override
	protected void onCreate(Bundle savedInstanceState) {
		Window window = getWindow();
		WindowCompat.setDecorFitsSystemWindows(window, false);
		window.setStatusBarColor(Color.TRANSPARENT);
		window.setNavigationBarColor(Color.TRANSPARENT);
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
			window.setStatusBarContrastEnforced(false);
			window.setNavigationBarContrastEnforced(false);
		}

		registerPlugin(TabHapticsPlugin.class);
		super.onCreate(savedInstanceState);

		WindowInsetsControllerCompat insetsController =
				WindowCompat.getInsetsController(window, window.getDecorView());
		insetsController.setAppearanceLightStatusBars(false);
		insetsController.setAppearanceLightNavigationBars(false);
	}
}
