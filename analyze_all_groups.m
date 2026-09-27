%% Across-group analysis for JointAgency2
% Edit this numeric vector to choose groups. Gaps are allowed.
% Examples: [1 2 3 4 5], [1 3 4 5], [2 6 9]
groupNumbers = [1 2 3 4 5 6:10, 12 13];

% Robust outlier criterion for distance samples within each trial.
% A sample is excluded when its |modified Z-score| relative to the other
% samples in that trial exceeds this value and its absolute deviation is
% sufficiently large.
errorOutlierModifiedZThreshold = 3.5;
errorOutlierMinimumSampleN = 20;
% Also require a deviation of at least 0.05 in normalized stage units.
% This guard prevents a nearly zero MAD from flagging trivial differences.
errorOutlierMinimumAbsoluteDeviation = 0.05;

close all;
clc;

projectFolder = fileparts(mfilename('fullpath'));
analyzedDataFolder = fullfile(projectFolder, 'AnalyzedData');
assert(isfolder(analyzedDataFolder), ...
    'AnalyzedData folder not found: %s', analyzedDataFolder);

% Plotting colors.
test1Color = [0.90 0.12 0.12];
test2Color = [0.10 0.28 0.92];
sharedColor = [0.00 0.55 0.20];
lightTest1Color = [1.00 0.68 0.68];
lightTest2Color = [0.66 0.74 1.00];
individualGray = [0.72 0.72 0.72];

groupResults = struct([]);

for groupNo = groupNumbers(:)'
    groupName = "g" + string(groupNo);
    matPath = fullfile(analyzedDataFolder, groupName + "_mat.mat");
    if ~isfile(matPath)
        warning('Skipping %s: MAT file not found: %s', groupName, matPath);
        continue;
    end

    loaded = load(matPath, 'trialData', 'frameTable', 'identityMap');
    if ~isfield(loaded, 'trialData') || isempty(loaded.trialData)
        warning('Skipping %s: trialData is missing or empty.', groupName);
        continue;
    end

    metrics = computeGroupMetrics(loaded, errorOutlierModifiedZThreshold, ...
        errorOutlierMinimumSampleN, errorOutlierMinimumAbsoluteDeviation);
    originalMeanRatio = mean(metrics.movementRatio(6:12), 'omitnan');
    if ~isfinite(originalMeanRatio)
        warning('Skipping %s: no valid shared-trial movement ratio.', groupName);
        continue;
    end

    % Analysis test1 is the participant with the larger mean movement share.
    swapParticipants = originalMeanRatio < 0.5;
    [metrics, analysisTest1ID, analysisTest2ID, originalTest1ID, originalTest2ID] = ...
        relabelByMovement(metrics, loaded, swapParticipants);

    result = struct();
    result.groupNumber = groupNo;
    result.groupName = groupName;
    result.matPath = string(matPath);
    result.swapped = swapParticipants;
    result.originalMeanMovementRatio = originalMeanRatio;
    result.meanMovementRatio = mean(metrics.movementRatio(6:12), 'omitnan');
    result.originalTest1ID = originalTest1ID;
    result.originalTest2ID = originalTest2ID;
    result.analysisTest1ID = analysisTest1ID;
    result.analysisTest2ID = analysisTest2ID;
    result.metrics = metrics;
    if isempty(groupResults)
        groupResults = result;
    else
        groupResults(end + 1) = result; %#ok<SAGROW>
    end
end

assert(~isempty(groupResults), 'No valid group data were loaded.');

%% Assemble matrices: rows = groups, columns = fixed trial slots 1:15.
nGroups = numel(groupResults);
distanceTest1 = nan(nGroups, 15);
distanceTest2 = nan(nGroups, 15);
distanceShared = nan(nGroups, 15);
movementRatio = nan(nGroups, 15);
questionTest1 = nan(nGroups, 15);
questionTest2 = nan(nGroups, 15);

for gi = 1:nGroups
    metrics = groupResults(gi).metrics;
    distanceTest1(gi, :) = metrics.distanceErrorTest1;
    distanceTest2(gi, :) = metrics.distanceErrorTest2;
    distanceShared(gi, :) = metrics.distanceErrorShared;
    movementRatio(gi, :) = metrics.movementRatio;
    questionTest1(gi, :) = metrics.questionTest1;
    questionTest2(gi, :) = metrics.questionTest2;
end

trialAxis = 1:15;

%% Figure 1: across-trial group overlays.
fig1 = figure( ...
    'Name', 'Figure 1 — Across-group trial summary', ...
    'Color', 'w', ...
    'Units', 'pixels', ...
    'Position', [100 70 1250 930]);
layout1 = tiledlayout(fig1, 3, 1, ...
    'TileSpacing', 'compact', ...
    'Padding', 'compact');

% 1) Mean tracking error.
distanceAx = nexttile(layout1, 1);
hold(distanceAx, 'on');
for gi = 1:nGroups
    plot(distanceAx, trialAxis, distanceTest1(gi, :), '-o', ...
        'Color', lightTest1Color, 'LineWidth', 0.9, 'MarkerSize', 3, ...
        'HandleVisibility', 'off');
    plot(distanceAx, trialAxis, distanceTest2(gi, :), '-o', ...
        'Color', lightTest2Color, 'LineWidth', 0.9, 'MarkerSize', 3, ...
        'HandleVisibility', 'off');
    plot(distanceAx, trialAxis, distanceShared(gi, :), '-o', ...
        'Color', individualGray, 'LineWidth', 0.9, 'MarkerSize', 3, ...
        'HandleVisibility', 'off');
end

% Legend handles for individual participant colors.
hTest1 = plot(distanceAx, nan, nan, '-o', ...
    'Color', lightTest1Color, 'LineWidth', 1.2, 'DisplayName', 'test1 groups');
hTest2 = plot(distanceAx, nan, nan, '-o', ...
    'Color', lightTest2Color, 'LineWidth', 1.2, 'DisplayName', 'test2 groups');
hSharedGroups = plot(distanceAx, nan, nan, '-o', ...
    'Color', individualGray, 'LineWidth', 1.2, 'DisplayName', 'shared groups');

meanSharedError = mean(distanceShared, 1, 'omitnan');
hSharedMean = plot(distanceAx, trialAxis, meanSharedError, '-o', ...
    'Color', [0 0 0], 'MarkerFaceColor', [0 0 0], ...
    'LineWidth', 2.8, 'MarkerSize', 5, 'DisplayName', 'shared group mean');
title(distanceAx, 'Mean tracking error (within-trial outliers excluded)');
ylabel(distanceAx, 'Mean tracking error');
legend(distanceAx, [hTest1 hTest2 hSharedGroups hSharedMean], ...
    'Location', 'best', 'Orientation', 'horizontal', 'Box', 'off');
formatTrialAxis(distanceAx);

% 2) Movement ratio.
movementAx = nexttile(layout1, 2);
hold(movementAx, 'on');
for gi = 1:nGroups
    plot(movementAx, trialAxis, movementRatio(gi, :), '-o', ...
        'Color', individualGray, 'LineWidth', 0.9, 'MarkerSize', 3, ...
        'HandleVisibility', 'off');
end
meanMovementRatio = mean(movementRatio, 1, 'omitnan');
plot(movementAx, trialAxis, meanMovementRatio, '-o', ...
    'Color', [0 0 0], 'MarkerFaceColor', [0 0 0], ...
    'LineWidth', 2.8, 'MarkerSize', 5, 'DisplayName', 'group mean');
yline(movementAx, 0.5, ':', 'Equal movement', ...
    'Color', [0.42 0.42 0.42], 'HandleVisibility', 'off');
title(movementAx, 'Movement ratio: test1 / (test1 + test2)');
ylabel(movementAx, 'test1 proportion');
ylim(movementAx, [0 1]);
legend(movementAx, 'Location', 'best', 'Box', 'off');
formatTrialAxis(movementAx);

% 3) Perceived contribution rating.
questionAx = nexttile(layout1, 3);
hold(questionAx, 'on');
for gi = 1:nGroups
    plot(questionAx, trialAxis, questionTest1(gi, :), '-o', ...
        'Color', lightTest1Color, 'LineWidth', 0.9, 'MarkerSize', 3, ...
        'HandleVisibility', 'off');
    plot(questionAx, trialAxis, questionTest2(gi, :), '-o', ...
        'Color', lightTest2Color, 'LineWidth', 0.9, 'MarkerSize', 3, ...
        'HandleVisibility', 'off');
end
meanQuestionTest1 = mean(questionTest1, 1, 'omitnan');
meanQuestionTest2 = mean(questionTest2, 1, 'omitnan');
plot(questionAx, trialAxis, meanQuestionTest1, '-o', ...
    'Color', test1Color, 'MarkerFaceColor', test1Color, ...
    'LineWidth', 2.8, 'MarkerSize', 5, 'DisplayName', 'test1 group mean');
plot(questionAx, trialAxis, meanQuestionTest2, '-o', ...
    'Color', test2Color, 'MarkerFaceColor', test2Color, ...
    'LineWidth', 2.8, 'MarkerSize', 5, 'DisplayName', 'test2 group mean');
yline(questionAx, 4, ':', 'Equal contribution', ...
    'Color', [0.42 0.42 0.42], ...
    'LabelHorizontalAlignment', 'right', ...
    'HandleVisibility', 'off');
title(questionAx, 'Perceived contribution rating');
ylabel(questionAx, '1 = partner, 7 = self');
xlabel(questionAx, 'Trial');
ylim(questionAx, [0.5 7.5]);
yticks(questionAx, 1:7);
legend(questionAx, 'Location', 'best', 'Orientation', 'horizontal', 'Box', 'off');
formatTrialAxis(questionAx);

title(layout1, sprintf('Figure 1 — Across-group results (N = %d pairs)', nGroups), ...
    'FontWeight', 'bold');

%% Figure 2: correlation analyses.
baselineErrorDifference = nan(nGroups, 1);
meanSharedMovementRatio = nan(nGroups, 1);
for gi = 1:nGroups
    baselineErrorDifference(gi) = ...
        mean(distanceTest1(gi, 1:5), 'omitnan') - ...
        mean(distanceTest2(gi, 1:5), 'omitnan');
    meanSharedMovementRatio(gi) = mean(movementRatio(gi, 6:12), 'omitnan');
end

pooledMovementRatio = reshape(movementRatio(:, 6:12)', [], 1);
pooledMovementRatioTest2 = 1 - pooledMovementRatio;
pooledQuestionTest1 = reshape(questionTest1(:, 6:12)', [], 1);
pooledQuestionTest2 = reshape(questionTest2(:, 6:12)', [], 1);

fig2 = figure( ...
    'Name', 'Figure 2 — Correlation analyses', ...
    'Color', 'w', ...
    'Units', 'pixels', ...
    'Position', [160 100 1150 860]);
layout2 = tiledlayout(fig2, 2, 2, ...
    'TileSpacing', 'compact', ...
    'Padding', 'compact');

correlationResults = struct();

axCorr1 = nexttile(layout2, 1);
correlationResults.baselineErrorDifferenceVsMovementRatio = ...
    drawCorrelationPanel(axCorr1, baselineErrorDifference, ...
    meanSharedMovementRatio, [0.25 0.25 0.25], ...
    'Baseline error difference vs mean movement ratio', ...
    'Mean baseline error: test1 - test2', ...
    'Mean shared movement ratio');
labelGroupPoints(axCorr1, baselineErrorDifference, ...
    meanSharedMovementRatio, [groupResults.groupNumber]);

axCorr2 = nexttile(layout2, 2);
correlationResults.questionTest1VsTest2 = ...
    drawCorrelationPanel(axCorr2, pooledQuestionTest1, ...
    pooledQuestionTest2, [0.45 0.20 0.60], ...
    'Question responses: test1 vs test2', ...
    'test1 perceived contribution', ...
    'test2 perceived contribution');
xlim(axCorr2, [0.5 7.5]);
ylim(axCorr2, [0.5 7.5]);
xticks(axCorr2, 1:7);
yticks(axCorr2, 1:7);
hold(axCorr2, 'on');
plot(axCorr2, [1 7], [1 7], ':', 'Color', [0.6 0.6 0.6], ...
    'HandleVisibility', 'off');

axCorr3 = nexttile(layout2, 3);
correlationResults.movementRatioVsQuestionTest1 = ...
    drawCorrelationPanel(axCorr3, pooledMovementRatio, ...
    pooledQuestionTest1, test1Color, ...
    'Movement ratio vs test1 response', ...
    'Movement ratio', 'test1 perceived contribution');
xlim(axCorr3, [0 1]);
ylim(axCorr3, [0.5 7.5]);
yticks(axCorr3, 1:7);

axCorr4 = nexttile(layout2, 4);
correlationResults.movementRatioVsQuestionTest2 = ...
    drawCorrelationPanel(axCorr4, pooledMovementRatioTest2, ...
    pooledQuestionTest2, test2Color, ...
    'Test2 movement ratio vs test2 response', ...
    'test2 movement ratio', 'test2 perceived contribution');
xlim(axCorr4, [0 1]);
ylim(axCorr4, [0.5 7.5]);
yticks(axCorr4, 1:7);

title(layout2, 'Figure 2 — Correlation analyses', 'FontWeight', 'bold');

%% Display participant relabeling and correlation statistics.
groupNameColumn = string({groupResults.groupName})';
swappedColumn = [groupResults.swapped]';
originalTest1Column = string({groupResults.originalTest1ID})';
originalTest2Column = string({groupResults.originalTest2ID})';
analysisTest1Column = string({groupResults.analysisTest1ID})';
analysisTest2Column = string({groupResults.analysisTest2ID})';
meanMovementColumn = [groupResults.meanMovementRatio]';

participantAssignmentTable = table( ...
    groupNameColumn, swappedColumn, ...
    originalTest1Column, originalTest2Column, ...
    analysisTest1Column, analysisTest2Column, meanMovementColumn, ...
    'VariableNames', {'group', 'swapped', ...
    'originalTest1', 'originalTest2', ...
    'analysisTest1', 'analysisTest2', 'meanMovementRatio'});

fprintf('\nParticipant assignments used in this analysis:\n');
disp(participantAssignmentTable);
fprintf('\nCorrelation results:\n');
disp(correlationStructToTable(correlationResults));
fprintf(['\nWithin-trial distance outlier filtering: ' ...
    '|modified Z| > %.1f, absolute deviation >= %.3f, minimum samples = %d.\n'], ...
    errorOutlierModifiedZThreshold, errorOutlierMinimumAbsoluteDeviation, ...
    errorOutlierMinimumSampleN);

% Optional exports:
% exportgraphics(fig1, fullfile(analyzedDataFolder, 'Figure1_group_results.png'), ...
%     'Resolution', 300);
% exportgraphics(fig2, fullfile(analyzedDataFolder, 'Figure2_correlations.png'), ...
%     'Resolution', 300);

%% Local functions
function metrics = computeGroupMetrics(loaded, modifiedZThreshold, ...
        minimumSampleN, minimumAbsoluteDeviation)
    trials = loaded.trialData;
    [~, order] = sort([trials.trialNumber]);
    trials = trials(order);
    slotTrials = placeTrialsInSlots(trials);

    metrics = struct();
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
                trial.sharedTargetX, trial.sharedTargetY, sharedMask, ...
                modifiedZThreshold, minimumSampleN, minimumAbsoluteDeviation);

            movement1 = totalMovementDistance( ...
                trial.test1_HandX, trial.test1_HandY, mask1);
            movement2 = totalMovementDistance( ...
                trial.test2_HandX, trial.test2_HandY, mask2);
            denominator = movement1 + movement2;
            if isfinite(denominator) && denominator > 0
                metrics.movementRatio(slot) = movement1 / denominator;
            end
            metrics.questionTest1(slot) = firstNumericValue( ...
                trial.test1_question_response);
            metrics.questionTest2(slot) = firstNumericValue( ...
                trial.test2_question_response);
        elseif phaseName == "baseline" || phaseName == "washout"
            metrics.distanceErrorTest1(slot) = timeWeightedDistanceError( ...
                time1, trial.test1_HandX, trial.test1_HandY, ...
                trial.test1_TargetX, trial.test1_TargetY, mask1, ...
                modifiedZThreshold, minimumSampleN, minimumAbsoluteDeviation);
            metrics.distanceErrorTest2(slot) = timeWeightedDistanceError( ...
                time2, trial.test2_HandX, trial.test2_HandY, ...
                trial.test2_TargetX, trial.test2_TargetY, mask2, ...
                modifiedZThreshold, minimumSampleN, minimumAbsoluteDeviation);
        end
    end
end

function slots = placeTrialsInSlots(trials)
    slots = cell(1, 15);
    counts = struct('baseline', 0, 'shared', 0, 'washout', 0);
    for ti = 1:numel(trials)
        phaseName = lower(string(trials(ti).phase));
        switch phaseName
            case "baseline"
                counts.baseline = counts.baseline + 1;
                slot = counts.baseline;
                maxCount = 5;
            case "shared"
                counts.shared = counts.shared + 1;
                slot = 5 + counts.shared;
                maxCount = 7;
            case "washout"
                counts.washout = counts.washout + 1;
                slot = 12 + counts.washout;
                maxCount = 3;
            otherwise
                continue;
        end
        if counts.(char(phaseName)) <= maxCount
            slots{slot} = trials(ti);
        end
    end
end

function [metrics, analysisTest1ID, analysisTest2ID, originalTest1ID, originalTest2ID] = ...
        relabelByMovement(metrics, loaded, swapParticipants)
    originalTest1ID = "unknown";
    originalTest2ID = "unknown";
    if isfield(loaded, 'identityMap') && istable(loaded.identityMap) && ...
            height(loaded.identityMap) >= 2
        originalTest1ID = string(loaded.identityMap.OriginalIdentity(1));
        originalTest2ID = string(loaded.identityMap.OriginalIdentity(2));
    end

    if swapParticipants
        temporary = metrics.distanceErrorTest1;
        metrics.distanceErrorTest1 = metrics.distanceErrorTest2;
        metrics.distanceErrorTest2 = temporary;

        metrics.movementRatio = 1 - metrics.movementRatio;

        temporary = metrics.questionTest1;
        metrics.questionTest1 = metrics.questionTest2;
        metrics.questionTest2 = temporary;

        analysisTest1ID = originalTest2ID;
        analysisTest2ID = originalTest1ID;
    else
        analysisTest1ID = originalTest1ID;
        analysisTest2ID = originalTest2ID;
    end
end

function durationSec = getTrackingDurationSec(loaded, trialNumber)
    durationSec = 20;
    if ~isfield(loaded, 'frameTable') || ~istable(loaded.frameTable)
        return;
    end
    T = loaded.frameTable;
    if ~all(ismember({'trialNumber', 'trackingDurationMs'}, T.Properties.VariableNames))
        return;
    end
    values = T.trackingDurationMs(T.trialNumber == trialNumber);
    values = values(isfinite(values));
    if ~isempty(values) && values(1) > 0
        durationSec = values(1) / 1000;
    end
end

function activeMask = makeTrackingMask(timeSec, durationSec)
    timeSec = double(timeSec(:));
    activeMask = isfinite(timeSec) & timeSec >= 0;
    if isfinite(durationSec)
        activeMask = activeMask & timeSec <= durationSec;
    end
end

function value = timeWeightedDistanceError(timeSec, cursorX, cursorY, ...
        targetX, targetY, activeMask, modifiedZThreshold, minimumSampleN, ...
        minimumAbsoluteDeviation)
    [timeSec, cursorX, cursorY, targetX, targetY, activeMask] = ...
        alignVectors(timeSec, cursorX, cursorY, targetX, targetY, activeMask);
    valid = logical(activeMask) & isfinite(timeSec) & isfinite(cursorX) & ...
        isfinite(cursorY) & isfinite(targetX) & isfinite(targetY);
    timeSec = double(timeSec(valid));
    errorDistance = hypot(double(cursorX(valid)) - double(targetX(valid)), ...
        double(cursorY(valid)) - double(targetY(valid)));
    if numel(errorDistance) >= minimumSampleN
        center = median(errorDistance, 'omitnan');
        rawMAD = median(abs(errorDistance - center), 'omitnan');
        if isfinite(rawMAD) && rawMAD > eps(max(1, abs(center)))
            modifiedZ = 0.67448975 * (errorDistance - center) / rawMAD;
            absoluteDeviation = abs(errorDistance - center);
            remove = abs(modifiedZ) > modifiedZThreshold & ...
                absoluteDeviation >= minimumAbsoluteDeviation;
            errorDistance(remove) = nan;
        end
    end
    validDistance = isfinite(timeSec) & isfinite(errorDistance);
    timeSec = timeSec(validDistance);
    errorDistance = errorDistance(validDistance);
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
    steps = hypot(diff(x), diff(y));
    distance = sum(steps(validPair), 'omitnan');
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

function formatTrialAxis(ax)
    xlim(ax, [0.5 15.5]);
    xticks(ax, 1:15);
    grid(ax, 'on');
    box(ax, 'on');
    set(ax, 'FontSize', 9, 'Layer', 'top');
    xline(ax, 5.5, '--', 'Color', [0.50 0.50 0.50], ...
        'HandleVisibility', 'off');
    xline(ax, 12.5, '--', 'Color', [0.50 0.50 0.50], ...
        'HandleVisibility', 'off');
end

function stats = drawCorrelationPanel(ax, x, y, pointColor, ...
        panelTitle, xLabelText, yLabelText)
    x = double(x(:));
    y = double(y(:));
    valid = isfinite(x) & isfinite(y);
    xValid = x(valid);
    yValid = y(valid);

    scatter(ax, xValid, yValid, 42, pointColor, 'filled', ...
        'MarkerFaceAlpha', 0.70, ...
        'MarkerEdgeColor', [0.15 0.15 0.15], ...
        'LineWidth', 0.4);
    hold(ax, 'on');
    grid(ax, 'on');
    box(ax, 'on');

    stats = pearsonStatistics(xValid, yValid);
    if stats.n >= 2 && range(xValid) > 0
        coefficients = polyfit(xValid, yValid, 1);
        xLine = linspace(min(xValid), max(xValid), 100);
        plot(ax, xLine, polyval(coefficients, xLine), '-', ...
            'Color', [0 0 0], 'LineWidth', 1.8);
    end

    title(ax, sprintf('%s\nr = %.3f, p = %s, n = %d', ...
        panelTitle, stats.r, formatPValue(stats.p), stats.n), ...
        'FontWeight', 'bold');
    xlabel(ax, xLabelText);
    ylabel(ax, yLabelText);
end

function stats = pearsonStatistics(x, y)
    valid = isfinite(x) & isfinite(y);
    x = x(valid);
    y = y(valid);
    stats = struct('r', nan, 'p', nan, 'n', numel(x));
    if stats.n < 3 || range(x) == 0 || range(y) == 0
        return;
    end
    [R, P] = corrcoef(x, y);
    stats.r = R(1, 2);
    stats.p = P(1, 2);
end

function labelGroupPoints(ax, x, y, groupNumbers)
    for i = 1:numel(groupNumbers)
        if isfinite(x(i)) && isfinite(y(i))
            text(ax, x(i), y(i), "  g" + string(groupNumbers(i)), ...
                'FontSize', 8, 'VerticalAlignment', 'bottom');
        end
    end
end

function output = formatPValue(p)
    if ~isfinite(p)
        output = 'n/a';
    elseif p < 0.001
        output = '< .001';
    else
        output = sprintf('%.3f', p);
    end
end

function T = correlationStructToTable(results)
    names = string(fieldnames(results));
    r = nan(numel(names), 1);
    p = nan(numel(names), 1);
    n = nan(numel(names), 1);
    for i = 1:numel(names)
        stats = results.(names(i));
        r(i) = stats.r;
        p(i) = stats.p;
        n(i) = stats.n;
    end
    T = table(names, r, p, n, ...
        'VariableNames', {'analysis', 'r', 'p', 'n'});
end
