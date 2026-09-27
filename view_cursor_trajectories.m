function [fig, metrics] = view_cursor_trajectories(matPath)
%VIEW_CURSOR_TRAJECTORIES Interactive trajectory and performance viewer.
%
% Rows:
%   1: test1 hand/cursor trajectory (red)
%   2: test2 hand/cursor trajectory (blue)
%   3: shared cursor trajectory for shared trials only (green)
%
% Columns:
%   1-5:   baseline
%   6-12:  shared
%   13-15: washout
%
% The upper section shows trajectory overlays. The lower-left section uses
% a trial selector to show X/Y time series. The lower-right section shows
% mean tracking error, movement ratio, and perceived-contribution ratings.
%
% Usage:
%   view_cursor_trajectories
%   view_cursor_trajectories("AnalyzedData\g1_mat.mat")
%   [fig, metrics] = view_cursor_trajectories(...);
%   exportapp(fig, "g1_trajectories.png");

if nargin < 1 || isempty(matPath)
    scriptFolder = fileparts(mfilename('fullpath'));
    defaultFolder = fullfile(scriptFolder, 'AnalyzedData');
    if ~isfolder(defaultFolder)
        defaultFolder = scriptFolder;
    end
    [fileName, folderName] = uigetfile( ...
        fullfile(defaultFolder, '*.mat'), ...
        'Select converted trial data');
    if isequal(fileName, 0)
        error('No MAT file selected.');
    end
    matPath = fullfile(folderName, fileName);
end

matPath = string(matPath);
assert(isfile(matPath), 'MAT file not found: %s', matPath);

loaded = load(matPath, 'trialData', 'frameTable');
assert(isfield(loaded, 'trialData'), 'The MAT file does not contain trialData.');
trials = loaded.trialData;
assert(isstruct(trials) && ~isempty(trials), 'trialData is empty or invalid.');

requiredFields = [
    "trialNumber", "phase", ...
    "test1_timeFromTrialStartSec", "test2_timeFromTrialStartSec", ...
    "test1_HandX", "test1_HandY", "test2_HandX", "test2_HandY", ...
    "test1_TargetX", "test1_TargetY", "test2_TargetX", "test2_TargetY", ...
    "sharedCursorX", "sharedCursorY", "sharedTargetX", "sharedTargetY"
];
missingFields = setdiff(requiredFields, string(fieldnames(trials)));
assert(isempty(missingFields), 'trialData is missing fields: %s', ...
    strjoin(missingFields, ', '));

% Ensure trial order is deterministic, then place trials into fixed phase slots.
[~, order] = sort([trials.trialNumber]);
trials = trials(order);
slotTrials = cell(1, 15);
phaseCounts = struct('baseline', 0, 'shared', 0, 'washout', 0);

for ti = 1:numel(trials)
    phaseName = lower(string(trials(ti).phase));
    switch phaseName
        case "baseline"
            phaseCounts.baseline = phaseCounts.baseline + 1;
            slot = phaseCounts.baseline;
            maxCount = 5;
        case "shared"
            phaseCounts.shared = phaseCounts.shared + 1;
            slot = 5 + phaseCounts.shared;
            maxCount = 7;
        case "washout"
            phaseCounts.washout = phaseCounts.washout + 1;
            slot = 12 + phaseCounts.washout;
            maxCount = 3;
        otherwise
            warning('Ignoring trial %g with unknown phase "%s".', ...
                trials(ti).trialNumber, phaseName);
            continue;
    end

    if phaseCounts.(char(phaseName)) > maxCount
        warning('Ignoring extra %s trial %g; the layout allows %d.', ...
            phaseName, trials(ti).trialNumber, maxCount);
        continue;
    end
    slotTrials{slot} = trials(ti);
end

targetColor = [0.08 0.08 0.08];
test1Color = [0.90 0.12 0.12];
test2Color = [0.10 0.28 0.92];
sharedColor = [0.00 0.55 0.20];
cursorAlpha = 0.38;

metrics = computeTrialMetrics(slotTrials, loaded);

fig = figure( ...
    'Name', 'Cursor trajectory viewer', ...
    'Color', 'w', ...
    'Units', 'pixels', ...
    'Position', [30 30 2400 1240]);

topPanel = uipanel(fig, ...
    'Units', 'normalized', ...
    'Position', [0.015 0.52 0.97 0.46], ...
    'BorderType', 'none', ...
    'BackgroundColor', 'w');
layout = tiledlayout(topPanel, 3, 15, ...
    'TileSpacing', 'compact', ...
    'Padding', 'compact');

% Rows 1 and 2: participant trajectories for every trial.
for column = 1:15
    trial = slotTrials{column};

    ax1 = nexttile(layout, column);
    if isempty(trial)
        drawMissingPanel(ax1, column);
    else
        trackingDurationSec = getTrackingDurationSec(loaded, trial.trialNumber);
        test1Mask = makeTrackingMask( ...
            trial.test1_timeFromTrialStartSec, trackingDurationSec);
        drawTrajectoryPanel(ax1, ...
            trial.test1_TargetX, trial.test1_TargetY, ...
            trial.test1_HandX, trial.test1_HandY, ...
            targetColor, test1Color, cursorAlpha, test1Mask);
        title(ax1, sprintf('Trial %g', trial.trialNumber), ...
            'FontSize', 8, 'FontWeight', 'normal');
    end
    if column == 1
        ylabel(ax1, 'test1', 'FontWeight', 'bold', 'FontSize', 10);
    end

    ax2 = nexttile(layout, 15 + column);
    if isempty(trial)
        drawMissingPanel(ax2, column);
    else
        trackingDurationSec = getTrackingDurationSec(loaded, trial.trialNumber);
        test2Mask = makeTrackingMask( ...
            trial.test2_timeFromTrialStartSec, trackingDurationSec);
        drawTrajectoryPanel(ax2, ...
            trial.test2_TargetX, trial.test2_TargetY, ...
            trial.test2_HandX, trial.test2_HandY, ...
            targetColor, test2Color, cursorAlpha, test2Mask);
    end
    if column == 1
        ylabel(ax2, 'test2', 'FontWeight', 'bold', 'FontSize', 10);
    end
end

% Row 3: use the otherwise-empty baseline/washout areas as phase labels.
baselineLabel = nexttile(layout, 31, [1 5]);
drawPhaseLabel(baselineLabel, 'BASELINE', 'Trials 1-5');

for sharedIndex = 1:7
    column = 5 + sharedIndex;
    trial = slotTrials{column};
    ax3 = nexttile(layout, 30 + column);
    if isempty(trial)
        drawMissingPanel(ax3, column);
    else
        trackingDurationSec = getTrackingDurationSec(loaded, trial.trialNumber);
        test1Mask = makeTrackingMask( ...
            trial.test1_timeFromTrialStartSec, trackingDurationSec);
        test2Mask = makeTrackingMask( ...
            trial.test2_timeFromTrialStartSec, trackingDurationSec);
        sharedMask = test1Mask & test2Mask;
        drawTrajectoryPanel(ax3, ...
            trial.sharedTargetX, trial.sharedTargetY, ...
            trial.sharedCursorX, trial.sharedCursorY, ...
            targetColor, sharedColor, cursorAlpha, sharedMask);
    end
    if sharedIndex == 1
        ylabel(ax3, 'shared cursor', 'FontWeight', 'bold', 'FontSize', 10);
    end
end

washoutLabel = nexttile(layout, 43, [1 3]);
drawPhaseLabel(washoutLabel, 'WASHOUT', 'Trials 13-15');

% Lower-left: selected-trial X/Y time series in a 3-by-2 layout.
timePanel = uipanel(fig, ...
    'Units', 'normalized', ...
    'Position', [0.015 0.035 0.455 0.425], ...
    'Title', 'Selected-trial position traces', ...
    'FontWeight', 'bold', ...
    'BackgroundColor', 'w');
timeLayout = tiledlayout(timePanel, 3, 2, ...
    'TileSpacing', 'compact', ...
    'Padding', 'compact');
timeAxes = gobjects(6, 1);
for ai = 1:6
    timeAxes(ai) = nexttile(timeLayout, ai);
end

availableSlots = find(~cellfun(@isempty, slotTrials));
trialOptions = strings(numel(availableSlots), 1);
for oi = 1:numel(availableSlots)
    trial = slotTrials{availableSlots(oi)};
    trialOptions(oi) = sprintf('Trial %g (%s)', ...
        trial.trialNumber, string(trial.phase));
end
defaultSelection = find(availableSlots == 6, 1, 'first');
if isempty(defaultSelection)
    defaultSelection = 1;
end

uicontrol(fig, ...
    'Style', 'text', ...
    'Units', 'normalized', ...
    'Position', [0.018 0.472 0.075 0.022], ...
    'String', 'Displayed trial:', ...
    'HorizontalAlignment', 'left', ...
    'FontWeight', 'bold', ...
    'BackgroundColor', 'w');
trialSelector = uicontrol(fig, ...
    'Style', 'popupmenu', ...
    'Units', 'normalized', ...
    'Position', [0.092 0.473 0.16 0.026], ...
    'String', cellstr(trialOptions), ...
    'Value', defaultSelection, ...
    'UserData', availableSlots, ...
    'BackgroundColor', 'w');
trialSelector.Callback = @(src, ~) updateSelectedTrialPlots( ...
    src, timeAxes, slotTrials, loaded, ...
    targetColor, test1Color, test2Color, sharedColor, cursorAlpha);
updateSelectedTrialPlots(trialSelector, timeAxes, slotTrials, loaded, ...
    targetColor, test1Color, test2Color, sharedColor, cursorAlpha);

% Lower-right: across-trial summary metrics in three aligned rows.
metricsPanel = uipanel(fig, ...
    'Units', 'normalized', ...
    'Position', [0.485 0.035 0.50 0.459], ...
    'Title', 'Across-trial summary', ...
    'FontWeight', 'bold', ...
    'BackgroundColor', 'w');
metricsLayout = tiledlayout(metricsPanel, 3, 1, ...
    'TileSpacing', 'compact', ...
    'Padding', 'compact');
drawMetricPanels(metricsLayout, metrics, test1Color, test2Color, sharedColor);

[~, fileStem] = fileparts(matPath);
protocolName = getProtocolName(trials);
if strlength(protocolName) > 0
    fig.Name = sprintf('%s | %s | Cursor trajectory viewer', fileStem, protocolName);
else
    fig.Name = sprintf('%s | Cursor trajectory viewer', fileStem);
end
end

function updateSelectedTrialPlots(selector, axesList, slotTrials, loaded, ...
        targetColor, test1Color, test2Color, sharedColor, cursorAlpha)
    availableSlots = selector.UserData;
    selectedSlot = availableSlots(selector.Value);
    trial = slotTrials{selectedSlot};
    durationSec = getTrackingDurationSec(loaded, trial.trialNumber);

    time1 = double(trial.test1_timeFromTrialStartSec(:));
    time2 = double(trial.test2_timeFromTrialStartSec(:));
    mask1 = makeTrackingMask(time1, durationSec);
    mask2 = makeTrackingMask(time2, durationSec);
    time1 = rezeroActiveTime(time1, mask1);
    time2 = rezeroActiveTime(time2, mask2);

    nShared = min([numel(time1), numel(time2), numel(mask1), numel(mask2)]);
    sharedMask = mask1(1:nShared) & mask2(1:nShared);
    sharedTime = max(time1(1:nShared), time2(1:nShared));
    sharedTime = rezeroActiveTime(sharedTime, sharedMask);

    drawTimeSeriesPanel(axesList(1), time1, ...
        trial.test1_TargetX, trial.test1_HandX, mask1, ...
        targetColor, test1Color, cursorAlpha, 'test1 — X', 'X position');
    drawTimeSeriesPanel(axesList(2), time1, ...
        trial.test1_TargetY, trial.test1_HandY, mask1, ...
        targetColor, test1Color, cursorAlpha, 'test1 — Y', 'Y position');
    drawTimeSeriesPanel(axesList(3), time2, ...
        trial.test2_TargetX, trial.test2_HandX, mask2, ...
        targetColor, test2Color, cursorAlpha, 'test2 — X', 'X position');
    drawTimeSeriesPanel(axesList(4), time2, ...
        trial.test2_TargetY, trial.test2_HandY, mask2, ...
        targetColor, test2Color, cursorAlpha, 'test2 — Y', 'Y position');
    drawTimeSeriesPanel(axesList(5), sharedTime, ...
        trial.sharedTargetX, trial.sharedCursorX, sharedMask, ...
        targetColor, sharedColor, cursorAlpha, 'shared cursor — X', 'X position');
    drawTimeSeriesPanel(axesList(6), sharedTime, ...
        trial.sharedTargetY, trial.sharedCursorY, sharedMask, ...
        targetColor, sharedColor, cursorAlpha, 'shared cursor — Y', 'Y position');

    for ai = 5:6
        xlabel(axesList(ai), 'Time from tracking start (s)');
    end
end

function drawTimeSeriesPanel(ax, timeSec, targetValue, cursorValue, activeMask, ...
        targetColor, cursorColor, cursorAlpha, panelTitle, yLabelText)
    cla(ax);
    timeSec = double(timeSec(:));
    targetValue = double(targetValue(:));
    cursorValue = double(cursorValue(:));
    activeMask = logical(activeMask(:));
    n = min([numel(timeSec), numel(targetValue), ...
        numel(cursorValue), numel(activeMask)]);
    timeSec = timeSec(1:n);
    targetValue = targetValue(1:n);
    cursorValue = cursorValue(1:n);
    activeMask = activeMask(1:n);

    timeSec(~activeMask) = nan;
    targetValue(~activeMask) = nan;
    cursorValue(~activeMask) = nan;

    hold(ax, 'on');
    targetLine = plot(ax, timeSec, targetValue, ...
        'Color', targetColor, 'LineWidth', 0.85, ...
        'DisplayName', 'Target');
    cursorLine = drawTranslucentLine(ax, timeSec, cursorValue, ...
        cursorColor, cursorAlpha, 2.4);
    cursorLine.DisplayName = 'Cursor';
    grid(ax, 'on');
    box(ax, 'on');
    ylim(ax, [0 1]);
    finiteTime = timeSec(isfinite(timeSec));
    if ~isempty(finiteTime)
        xlim(ax, [0 max(20, ceil(max(finiteTime)))]);
    end
    title(ax, panelTitle, 'FontSize', 9, 'FontWeight', 'bold');
    ylabel(ax, yLabelText, 'FontSize', 8);
    set(ax, 'FontSize', 8, 'Layer', 'top');

    if strcmp(panelTitle, 'test1 — X')
        legend(ax, [targetLine cursorLine], {'Target', 'Cursor'}, ...
            'Location', 'best', 'FontSize', 7, 'Box', 'off');
    end
end

function metrics = computeTrialMetrics(slotTrials, loaded)
    metrics = struct();
    metrics.trial = 1:15;
    metrics.distanceErrorTest1 = nan(1, 15);
    metrics.distanceErrorTest2 = nan(1, 15);
    metrics.distanceErrorShared = nan(1, 15);
    metrics.movementRatio = nan(1, 15);
    metrics.questionTest1 = nan(1, 15);
    metrics.questionTest2 = nan(1, 15);

    for slot = 1:15
        trial = slotTrials{slot};
        if isempty(trial)
            continue;
        end
        durationSec = getTrackingDurationSec(loaded, trial.trialNumber);
        time1 = double(trial.test1_timeFromTrialStartSec(:));
        time2 = double(trial.test2_timeFromTrialStartSec(:));
        mask1 = makeTrackingMask(time1, durationSec);
        mask2 = makeTrackingMask(time2, durationSec);
        phaseName = lower(string(trial.phase));

        if phaseName == "shared"
            nShared = min([numel(time1), numel(time2), numel(mask1), numel(mask2)]);
            sharedMask = mask1(1:nShared) & mask2(1:nShared);
            sharedTime = max(time1(1:nShared), time2(1:nShared));
            sharedTime = rezeroActiveTime(sharedTime, sharedMask);
            metrics.distanceErrorShared(slot) = timeWeightedDistanceError( ...
                sharedTime, trial.sharedCursorX, trial.sharedCursorY, ...
                trial.sharedTargetX, trial.sharedTargetY, sharedMask);

            distance1 = totalMovementDistance( ...
                trial.test1_HandX, trial.test1_HandY, mask1);
            distance2 = totalMovementDistance( ...
                trial.test2_HandX, trial.test2_HandY, mask2);
            denominator = distance1 + distance2;
            if isfinite(denominator) && denominator > 0
                metrics.movementRatio(slot) = distance1 / denominator;
            end

            metrics.questionTest1(slot) = firstNumericValue( ...
                trial.test1_question_response);
            metrics.questionTest2(slot) = firstNumericValue( ...
                trial.test2_question_response);
        elseif phaseName == "baseline" || phaseName == "washout"
            metrics.distanceErrorTest1(slot) = timeWeightedDistanceError( ...
                time1, trial.test1_HandX, trial.test1_HandY, ...
                trial.test1_TargetX, trial.test1_TargetY, mask1);
            metrics.distanceErrorTest2(slot) = timeWeightedDistanceError( ...
                time2, trial.test2_HandX, trial.test2_HandY, ...
                trial.test2_TargetX, trial.test2_TargetY, mask2);
        end
    end
end

function drawMetricPanels(layout, metrics, test1Color, test2Color, sharedColor)
    trialAxis = metrics.trial;

    distanceAx = nexttile(layout, 1);
    hold(distanceAx, 'on');
    plot(distanceAx, trialAxis, metrics.distanceErrorTest1, '-o', ...
        'Color', test1Color, 'MarkerFaceColor', test1Color, ...
        'LineWidth', 1.7, 'MarkerSize', 4, 'DisplayName', 'test1');
    plot(distanceAx, trialAxis, metrics.distanceErrorTest2, '-o', ...
        'Color', test2Color, 'MarkerFaceColor', test2Color, ...
        'LineWidth', 1.7, 'MarkerSize', 4, 'DisplayName', 'test2');
    plot(distanceAx, trialAxis, metrics.distanceErrorShared, '-o', ...
        'Color', sharedColor, 'MarkerFaceColor', sharedColor, ...
        'LineWidth', 1.7, 'MarkerSize', 4, 'DisplayName', 'shared');
    title(distanceAx, 'Mean tracking error');
    ylabel(distanceAx, 'Mean tracking error');
    legend(distanceAx, 'Location', 'best', 'Orientation', 'horizontal', 'Box', 'off');
    formatMetricAxis(distanceAx);

    movementAx = nexttile(layout, 2);
    plot(movementAx, trialAxis, metrics.movementRatio, '-o', ...
        'Color', test1Color, 'MarkerFaceColor', test1Color, ...
        'LineWidth', 1.7, 'MarkerSize', 4);
    hold(movementAx, 'on');
    yline(movementAx, 0.5, ':', 'Equal movement', ...
        'Color', [0.4 0.4 0.4], 'LabelHorizontalAlignment', 'left');
    title(movementAx, 'Movement ratio: test1 / (test1 + test2)');
    ylabel(movementAx, 'test1 proportion');
    ylim(movementAx, [0 1]);
    formatMetricAxis(movementAx);

    questionAx = nexttile(layout, 3);
    hold(questionAx, 'on');
    plot(questionAx, trialAxis, metrics.questionTest1, '-o', ...
        'Color', test1Color, 'MarkerFaceColor', test1Color, ...
        'LineWidth', 1.7, 'MarkerSize', 4, 'DisplayName', 'test1');
    plot(questionAx, trialAxis, metrics.questionTest2, '-o', ...
        'Color', test2Color, 'MarkerFaceColor', test2Color, ...
        'LineWidth', 1.7, 'MarkerSize', 4, 'DisplayName', 'test2');
    yline(questionAx, 4, ':', 'Equal contribution', ...
        'Color', [0.4 0.4 0.4], ...
        'LabelHorizontalAlignment', 'right', ...
        'HandleVisibility', 'off');
    title(questionAx, 'Perceived contribution rating');
    ylabel(questionAx, '1 = partner, 7 = self');
    xlabel(questionAx, 'Trial');
    ylim(questionAx, [0.5 7.5]);
    yticks(questionAx, 1:7);
    legend(questionAx, 'Location', 'best', 'Orientation', 'horizontal', 'Box', 'off');
    formatMetricAxis(questionAx);
end

function formatMetricAxis(ax)
    xlim(ax, [0.5 15.5]);
    xticks(ax, 1:15);
    grid(ax, 'on');
    box(ax, 'on');
    set(ax, 'FontSize', 8, 'Layer', 'top');
    xline(ax, 5.5, '--', 'Color', [0.55 0.55 0.55], ...
        'HandleVisibility', 'off');
    xline(ax, 12.5, '--', 'Color', [0.55 0.55 0.55], ...
        'HandleVisibility', 'off');
end

function value = timeWeightedDistanceError(timeSec, cursorX, cursorY, ...
        targetX, targetY, activeMask)
    [timeSec, cursorX, cursorY, targetX, targetY, activeMask] = ...
        alignVectors(timeSec, cursorX, cursorY, targetX, targetY, activeMask);
    valid = activeMask & isfinite(timeSec) & isfinite(cursorX) & ...
        isfinite(cursorY) & isfinite(targetX) & isfinite(targetY);
    timeSec = timeSec(valid);
    errorDistance = hypot(cursorX(valid) - targetX(valid), ...
        cursorY(valid) - targetY(valid));
    if numel(timeSec) < 2
        value = mean(errorDistance, 'omitnan');
        return;
    end
    [timeSec, uniqueIndex] = unique(timeSec, 'stable');
    errorDistance = errorDistance(uniqueIndex);
    elapsed = timeSec(end) - timeSec(1);
    if elapsed <= 0
        value = mean(errorDistance, 'omitnan');
    else
        value = trapz(timeSec, errorDistance) / elapsed;
    end
end

function distance = totalMovementDistance(x, y, activeMask)
    x = double(x(:));
    y = double(y(:));
    activeMask = logical(activeMask(:));
    n = min([numel(x), numel(y), numel(activeMask)]);
    x = x(1:n);
    y = y(1:n);
    activeMask = activeMask(1:n);
    if n < 2
        distance = nan;
        return;
    end
    validPair = activeMask(1:end-1) & activeMask(2:end) & ...
        isfinite(x(1:end-1)) & isfinite(x(2:end)) & ...
        isfinite(y(1:end-1)) & isfinite(y(2:end));
    stepDistance = hypot(diff(x), diff(y));
    distance = sum(stepDistance(validPair), 'omitnan');
end

function timeSec = rezeroActiveTime(timeSec, activeMask)
    timeSec = double(timeSec(:));
    activeMask = logical(activeMask(:));
    n = min(numel(timeSec), numel(activeMask));
    firstIndex = find(activeMask(1:n) & isfinite(timeSec(1:n)), 1, 'first');
    if ~isempty(firstIndex)
        timeSec = timeSec - timeSec(firstIndex);
    end
end

function value = firstNumericValue(inputValue)
    inputValue = double(inputValue(:));
    inputValue = inputValue(isfinite(inputValue));
    if isempty(inputValue)
        value = nan;
    else
        value = inputValue(1);
    end
end

function varargout = alignVectors(varargin)
    lengths = cellfun(@numel, varargin);
    n = min(lengths);
    varargout = cell(size(varargin));
    for i = 1:numel(varargin)
        value = varargin{i};
        value = value(:);
        varargout{i} = value(1:n);
    end
end

function lineHandle = drawTranslucentLine(ax, x, y, color, alpha, lineWidth)
    try
        lineHandle = patch(ax, ...
            'XData', x, ...
            'YData', y, ...
            'FaceColor', 'none', ...
            'EdgeColor', color, ...
            'EdgeAlpha', alpha, ...
            'LineWidth', lineWidth);
    catch
        blendedColor = alpha * color + (1 - alpha) * [1 1 1];
        lineHandle = plot(ax, x, y, ...
            'Color', blendedColor, ...
            'LineWidth', lineWidth);
    end
end

function drawTrajectoryPanel(ax, targetX, targetY, cursorX, cursorY, ...
        targetColor, cursorColor, cursorAlpha, activeMask)
    targetX = double(targetX(:));
    targetY = double(targetY(:));
    cursorX = double(cursorX(:));
    cursorY = double(cursorY(:));
    activeMask = logical(activeMask(:));

    n = min([numel(targetX), numel(targetY), numel(cursorX), ...
        numel(cursorY), numel(activeMask)]);
    targetX = targetX(1:n);
    targetY = targetY(1:n);
    cursorX = cursorX(1:n);
    cursorY = cursorY(1:n);
    activeMask = activeMask(1:n);

    targetX(~activeMask) = nan;
    targetY(~activeMask) = nan;
    cursorX(~activeMask) = nan;
    cursorY(~activeMask) = nan;

    hold(ax, 'on');
    plot(ax, targetX, targetY, ...
        'Color', targetColor, ...
        'LineWidth', 0.85);

    % Patch supports line transparency through EdgeAlpha. The fallback uses
    % a lightened RGB color on older MATLAB releases.
    try
        patch(ax, ...
            'XData', cursorX, ...
            'YData', cursorY, ...
            'FaceColor', 'none', ...
            'EdgeColor', cursorColor, ...
            'EdgeAlpha', cursorAlpha, ...
            'LineWidth', 2.4);
    catch
        blendedColor = cursorAlpha * cursorColor + (1 - cursorAlpha) * [1 1 1];
        plot(ax, cursorX, cursorY, ...
            'Color', blendedColor, ...
            'LineWidth', 2.4);
    end

    validCursor = find(isfinite(cursorX) & isfinite(cursorY));
    if ~isempty(validCursor)
        lastIndex = validCursor(end);
        scatter(ax, cursorX(lastIndex), cursorY(lastIndex), 24, ...
            cursorColor, 'filled', ...
            'MarkerEdgeColor', [0.15 0.15 0.15], ...
            'LineWidth', 0.55);
    end

    formatTrajectoryAxes(ax);
end

function activeMask = makeTrackingMask(timeFromStartSec, trackingDurationSec)
    timeFromStartSec = double(timeFromStartSec(:));
    if all(~isfinite(timeFromStartSec))
        activeMask = true(size(timeFromStartSec));
        return;
    end
    activeMask = isfinite(timeFromStartSec) & timeFromStartSec >= 0;
    if isfinite(trackingDurationSec)
        activeMask = activeMask & timeFromStartSec <= trackingDurationSec;
    end
end

function durationSec = getTrackingDurationSec(loaded, trialNumber)
    durationSec = 20; % Safe fallback for the current protocol.
    if ~isfield(loaded, 'frameTable') || ~istable(loaded.frameTable)
        return;
    end
    T = loaded.frameTable;
    required = {'trialNumber', 'trackingDurationMs'};
    if ~all(ismember(required, T.Properties.VariableNames))
        return;
    end
    values = T.trackingDurationMs(T.trialNumber == trialNumber);
    values = values(isfinite(values));
    if ~isempty(values) && values(1) > 0
        durationSec = values(1) / 1000;
    end
end

function drawMissingPanel(ax, column)
    formatTrajectoryAxes(ax);
    text(ax, 0.5, 0.5, sprintf('Trial slot %d\nmissing', column), ...
        'HorizontalAlignment', 'center', ...
        'VerticalAlignment', 'middle', ...
        'Color', [0.55 0.55 0.55], ...
        'FontSize', 8);
end

function drawPhaseLabel(ax, phaseName, trialText)
    axis(ax, 'off');
    xlim(ax, [0 1]);
    ylim(ax, [0 1]);
    rectangle(ax, ...
        'Position', [0.02 0.08 0.96 0.84], ...
        'Curvature', 0.04, ...
        'FaceColor', [0.965 0.965 0.965], ...
        'EdgeColor', [0.82 0.82 0.82], ...
        'LineWidth', 0.8);
    text(ax, 0.5, 0.56, phaseName, ...
        'HorizontalAlignment', 'center', ...
        'VerticalAlignment', 'middle', ...
        'FontSize', 16, ...
        'FontWeight', 'bold', ...
        'Color', [0.25 0.25 0.25]);
    text(ax, 0.5, 0.40, trialText, ...
        'HorizontalAlignment', 'center', ...
        'VerticalAlignment', 'middle', ...
        'FontSize', 9, ...
        'Color', [0.45 0.45 0.45]);
end

function formatTrajectoryAxes(ax)
    xlim(ax, [0 1]);
    ylim(ax, [0 1]);
    axis(ax, 'square');
    set(ax, ...
        'YDir', 'reverse', ...
        'XTick', [], ...
        'YTick', [], ...
        'Box', 'on', ...
        'LineWidth', 0.55, ...
        'Color', 'w', ...
        'XColor', [0.45 0.45 0.45], ...
        'YColor', [0.45 0.45 0.45]);
end

function protocolName = getProtocolName(trials)
    protocolName = "";
    if ~isfield(trials, 'taskType') || isempty(trials(1).taskType)
        return;
    end
    value = string(trials(1).taskType);
    if ~isempty(value)
        protocolName = value(1);
    end
end
