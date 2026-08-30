import React, { useCallback } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { getProviderIcon } from "@/components/provider-icons";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { getPromptPreview, getSessionTitle } from "@/components/import-session-sheet-view-model";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { formatTimeAgo } from "@/utils/time";
import type { RecentOpenCodeSession, RecentOpenCodeSessionsHostError } from "./query";

const OpenCodeIcon = withUnistyles(getProviderIcon("opencode"));
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ENABLED_ACCESSIBILITY_STATE = { disabled: false };
const DISABLED_ACCESSIBILITY_STATE = { disabled: true };
const OPENING_ACCESSIBILITY_STATE = { busy: true, disabled: true };
const BUSY_ACCESSIBILITY_STATE = { busy: true };

interface RecentOpenCodeSessionsSectionProps {
  sessions: readonly RecentOpenCodeSession[];
  errors: readonly RecentOpenCodeSessionsHostError[];
  isLoading: boolean;
  showHost: boolean;
  onOpen: (session: RecentOpenCodeSession) => Promise<void>;
}

function sessionKey(session: RecentOpenCodeSession): string {
  return `${session.serverId}:${session.entry.providerHandleId}`;
}

function rowAccessibilityState(disabled: boolean, opening: boolean) {
  if (opening) return OPENING_ACCESSIBILITY_STATE;
  if (disabled) return DISABLED_ACCESSIBILITY_STATE;
  return ENABLED_ACCESSIBILITY_STATE;
}

function hostErrorText(error: RecentOpenCodeSessionsHostError, t: TFunction): string {
  if (error.reason === "unsupported") {
    return t("sessions.openCode.updateHost", { host: error.serverName });
  }
  if (error.reason === "unreachable") {
    return t("sessions.openCode.hostUnavailable", { host: error.serverName });
  }
  return t("sessions.openCode.loadFailed", { host: error.serverName });
}

function RecentOpenCodeSessionRow({
  session,
  disabled,
  opening,
  showHost,
  onPress,
}: {
  session: RecentOpenCodeSession;
  disabled: boolean;
  opening: boolean;
  showHost: boolean;
  onPress: (session: RecentOpenCodeSession) => void;
}) {
  const { t } = useTranslation();
  const title = getSessionTitle(session.entry);
  const preview = getPromptPreview(session.entry);
  const activity = formatTimeAgo(new Date(session.entry.lastActivityAt));
  const metadata = showHost ? `${session.serverName} · ${session.entry.cwd}` : session.entry.cwd;
  const handlePress = useCallback(() => onPress(session), [onPress, session]);
  const rowStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      hovered && styles.rowHovered,
      pressed && styles.rowPressed,
      disabled && styles.rowDisabled,
    ],
    [disabled],
  );
  const accessibilityState = rowAccessibilityState(disabled, opening);
  const actionLabel = opening
    ? t("sessions.openCode.actions.opening")
    : t("sessions.openCode.actions.open");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${actionLabel}`}
      accessibilityState={accessibilityState}
      aria-busy={opening}
      disabled={disabled}
      onPress={handlePress}
      style={rowStyle}
      testID={`opencode-session-${session.serverId}-${session.entry.providerHandleId}`}
    >
      <View style={styles.iconWrap}>
        <OpenCodeIcon size={ICON_SIZE.md} uniProps={mutedColorMapping} />
      </View>
      <View style={styles.rowContent}>
        <View style={styles.rowHeader}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.activity}>{activity}</Text>
        </View>
        <Text style={styles.preview} numberOfLines={1}>
          {preview}
        </Text>
        <Text style={styles.metadata} numberOfLines={1}>
          {metadata}
        </Text>
      </View>
      <Text style={styles.openLabel} accessibilityLiveRegion="polite">
        {actionLabel}
      </Text>
    </Pressable>
  );
}

export function RecentOpenCodeSessionsSection({
  sessions,
  errors,
  isLoading,
  showHost,
  onOpen,
}: RecentOpenCodeSessionsSectionProps) {
  const { t } = useTranslation();
  const mutation = useMutation({ mutationFn: onOpen });
  const openingKey =
    mutation.isPending && mutation.variables ? sessionKey(mutation.variables) : null;
  const handleOpen = useCallback(
    (session: RecentOpenCodeSession) => mutation.mutate(session),
    [mutation],
  );
  if (!isLoading && sessions.length === 0 && errors.length === 0) return null;

  return (
    <View style={styles.section} testID="opencode-sessions-section">
      <Text style={styles.sectionTitle}>{t("sessions.openCode.title")}</Text>
      {errors.length > 0 ? (
        <View
          style={styles.errorBanner}
          testID="opencode-sessions-errors"
          accessibilityRole="alert"
        >
          {errors.map((error) => (
            <Text key={error.serverId} style={styles.errorText}>
              {hostErrorText(error, t)}
            </Text>
          ))}
        </View>
      ) : null}
      {mutation.isError ? (
        <View accessibilityRole="alert">
          <Text style={styles.errorText} testID="opencode-session-open-error">
            {t("sessions.openCode.openFailed")}
          </Text>
        </View>
      ) : null}
      {isLoading && sessions.length === 0 ? (
        <View
          style={styles.loadingRow}
          accessibilityRole="progressbar"
          accessibilityLabel={t("sessions.openCode.loading")}
          accessibilityLiveRegion="polite"
          accessibilityState={BUSY_ACCESSIBILITY_STATE}
          aria-busy
        >
          <ThemedLoadingSpinner size="small" uniProps={mutedColorMapping} />
          <Text style={styles.loadingText}>{t("sessions.openCode.loading")}</Text>
        </View>
      ) : null}
      {sessions.map((session) => (
        <RecentOpenCodeSessionRow
          key={sessionKey(session)}
          session={session}
          disabled={mutation.isPending}
          opening={openingKey === sessionKey(session)}
          showHost={showHost}
          onPress={handleOpen}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    gap: theme.spacing[1],
    marginBottom: theme.spacing[4],
  },
  sectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    marginBottom: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  errorBanner: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    gap: theme.spacing[1],
    marginBottom: theme.spacing[2],
    padding: theme.spacing[3],
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  loadingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  row: {
    alignItems: "center",
    borderRadius: {
      xs: theme.borderRadius.lg,
      md: 0,
    },
    flexDirection: "row",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  rowDisabled: {
    opacity: theme.opacity[50],
  },
  iconWrap: {
    alignItems: "center",
    justifyContent: "center",
    width: theme.iconSize.md,
  },
  rowContent: {
    flex: 1,
    gap: theme.spacing[1],
    minWidth: 0,
  },
  rowHeader: {
    alignItems: "baseline",
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  rowTitle: {
    color: theme.colors.foreground,
    flex: 1,
    fontSize: theme.fontSize.base,
    minWidth: 0,
  },
  activity: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  preview: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  metadata: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  openLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    minWidth: 64,
    textAlign: "right",
  },
}));
