function cursor_control_result_viewer(trialwiseMatPath, viewOptions)
%CURSOR_CONTROL_RESULT_VIEWER View trial-wise cursor-control trajectories.
%
% Usage:
%   cursor_control_result_viewer
%   cursor_control_result_viewer("C:\path\to\g1_trialwise.mat")
%   cursor_control_result_viewer("C:\path\to\g1_trialwise.mat", struct("groupNumber", 1))
%
% Expected MAT contents:
%   trialData struct array with fields:
%     trialNumber
%     timeFromTrialStartSec
%     test1_HandX, test1_HandY
%     test1_CursorX, test1_CursorY
%     test2_HandX, test2_HandY
%     test2_CursorX, test2_CursorY
%     sharedCursorX, sharedCursorY
%     targetX, targetY
%
% Layout:
%   Rows 1-2: baseline pre on the left and baseline post on the right.
%   Row 3: blank outside the animation area.
%   Rows 4-6: shared trials, participant 1/2/shared cursor.
%   Rows 1-3, middle columns: animation panel with UI controls.

if nargin < 1 || strlength(string(trialwiseMatPath)) == 0
    [fileName, folderName] = uigetfile("*.mat", "Select g##_trialwise.mat");
    if isequal(fileName, 0)
        return;
    end
    trialwiseMatPath = fullfile(folderName, fileName);
end
if nargin < 2
    viewOptions = struct();
end

S = load(trialwiseMatPath);
if ~isfield(S, "trialData")
    error("Selected MAT file does not contain trialData.");
end
trialData = S.trialData;
viewConfig = resolveViewConfig(trialwiseMatPath, trialData, viewOptions);
phaseTrials = inferPhaseTrials(trialData, viewConfig);
viewConfig.baselinePreTrialNumbers = phaseTrials.baselinePreTrialNumbers;
viewConfig.sharedTrialNumbers = phaseTrials.sharedTrialNumbers;
viewConfig.baselinePostTrialNumbers = phaseTrials.baselinePostTrialNumbers;

fig = figure( ...
    "Name", "Cursor Control Result Viewer", ...
    "Color", "w", ...
    "Units", "normalized", ...
    "Position", [0.02 0.06 0.96 0.86]);

tl = tiledlayout(fig, 6, 20, ...
    "TileSpacing", "compact", ...
    "Padding", "compact");

red = [0.85 0.10 0.10];
blue = [0.10 0.25 0.90];
paleRed = [1.00 0.38 0.38];
paleBlue = [0.38 0.50 1.00];
green = [0.05 0.60 0.25];
black = [0 0 0];

nPre = min(numel(phaseTrials.baselinePreTrialNumbers), 5);
nPost = min(numel(phaseTrials.baselinePostTrialNumbers), 5);
nShared = min(numel(phaseTrials.sharedTrialNumbers), 20);
preTrialNumbers = phaseTrials.baselinePreTrialNumbers(1:nPre);
postTrialNumbers = phaseTrials.baselinePostTrialNumbers(max(1, numel(phaseTrials.baselinePostTrialNumbers) - nPost + 1):end);
sharedTrialNumbers = phaseTrials.sharedTrialNumbers(1:nShared);
postStartCol = 21 - nPost;
animStartCol = nPre + 1;
animSpanCols = max(1, postStartCol - animStartCol);

% Reserve central top blank area for animation.
axAnim = nexttile(tl, tileIndex(1, animStartCol), [3 animSpanCols]);
hold(axAnim, "on");
formatTrajectoryAxes(axAnim, true);
title(axAnim, "Animation", "FontSize", 12);

% Static baseline pre.
for ii = 1:nPre
    trNo = preTrialNumbers(ii);
    col = ii;
    drawStaticPanel(tl, 1, col, trNo, "test1", red, 0.35, 2.0, 0.8);
    drawStaticPanel(tl, 2, col, trNo, "test2", blue, 0.35, 2.0, 0.8);
end

% Static baseline post, right-aligned.
for ii = 1:nPost
    trNo = postTrialNumbers(ii);
    col = postStartCol + ii - 1;
    drawStaticPanel(tl, 1, col, trNo, "test1", red, 0.35, 2.0, 0.8);
    drawStaticPanel(tl, 2, col, trNo, "test2", blue, 0.35, 2.0, 0.8);
end

% Empty row 3 outside animation area.
for col = [1:nPre postStartCol:20]
    ax = nexttile(tl, tileIndex(3, col));
    axis(ax, "off");
end

% Shared trials mapped from left to right.
for ii = 1:nShared
    trNo = sharedTrialNumbers(ii);
    col = ii;
    drawStaticPanel(tl, 4, col, trNo, "test1", red, 0.35, 2.0, 1.2);
    drawStaticPanel(tl, 5, col, trNo, "test2", blue, 0.35, 2.0, 1.2);
    drawStaticPanel(tl, 6, col, trNo, "shared", green, 0.35, 2.0, 1.2);
end

addRowLabel(tl, 1, "P1");
addRowLabel(tl, 2, "P2");
addRowLabel(tl, 4, "P1 hand");
addRowLabel(tl, 5, "P2 hand (P1 view)");
addRowLabel(tl, 6, "Shared cursor");

drawnow;

% Animation UI, placed around the central animation axes.
animPos = axAnim.Position;
uiLeft = max(0.005, animPos(1) - 0.085);
uiRight = min(0.98, animPos(1) + animPos(3) + 0.010);
uiBottom = animPos(2);
uiTop = animPos(2) + animPos(4);

trialNums = [trialData.trialNumber];
trialLabels = compose("Trial %d", trialNums);

uicontrol(fig, "Style", "text", "Units", "normalized", ...
    "Position", [uiLeft, uiTop - 0.035, 0.075, 0.025], ...
    "String", "Trial", "BackgroundColor", "w", "HorizontalAlignment", "left");

trialList = uicontrol(fig, "Style", "listbox", "Units", "normalized", ...
    "Position", [uiLeft, uiBottom + 0.090, 0.075, max(0.10, animPos(4) - 0.135)], ...
    "String", cellstr(trialLabels), ...
    "Value", defaultAnimationTrialIndex(trialData, phaseTrials), ...
    "Callback", @onTrialChanged);

playButton = uicontrol(fig, "Style", "togglebutton", "Units", "normalized", ...
    "Position", [uiLeft, uiBottom + 0.050, 0.075, 0.030], ...
    "String", "Play", ...
    "Callback", @onPlayToggled);

uicontrol(fig, "Style", "pushbutton", "Units", "normalized", ...
    "Position", [uiLeft, uiBottom + 0.014, 0.075, 0.030], ...
    "String", "Reset", ...
    "Callback", @onReset);

uicontrol(fig, "Style", "text", "Units", "normalized", ...
    "Position", [uiRight, uiTop - 0.035, 0.105, 0.025], ...
    "String", "Animation layers", "BackgroundColor", "w", "HorizontalAlignment", "left");

targetCheck = makeCheck("Target", uiRight, uiTop - 0.075, true, black);
p1HandCheck = makeCheck("Participant 1, hand", uiRight, uiTop - 0.115, true, red);
p1CursorCheck = makeCheck("Participant 1, cursor", uiRight, uiTop - 0.155, true, paleRed);
p2HandCheck = makeCheck("Participant 2, hand", uiRight, uiTop - 0.195, true, blue);
p2CursorCheck = makeCheck("Participant 2, cursor", uiRight, uiTop - 0.235, true, paleBlue);
sharedCheck = makeCheck("Shared cursor", uiRight, uiTop - 0.275, true, green);

timeText = uicontrol(fig, "Style", "text", "Units", "normalized", ...
    "Position", [uiRight, uiBottom + 0.014, 0.115, 0.030], ...
    "String", "t = 0.00 s", "BackgroundColor", "w", "HorizontalAlignment", "left");

timerObj = timer( ...
    "ExecutionMode", "fixedSpacing", ...
    "Period", 0.03, ...
    "TimerFcn", @onTimerTick);

animState.currentFrame = 1;
animState.currentTrialIndex = trialList.Value;
animState.speed = 2.0;
animState.handles = struct();
fig.CloseRequestFcn = @onClose;

initializeAnimation();

    function drawStaticPanel(layoutObj, row, col, trNo, dataKind, lineColor, alphaValue, lineWidthValue, targetLineWidth)
        ax = nexttile(layoutObj, tileIndex(row, col));
        hold(ax, "on");
        formatTrajectoryAxes(ax, false);

        tr = getTrial(trNo);
        if isempty(tr)
            axis(ax, "off");
            return;
        end

        [targetPlotX, targetPlotY] = targetSeries(tr, dataKind);
        plotTrajectory(ax, targetPlotX, targetPlotY, black, 1.0, targetLineWidth);

        switch dataKind
            case "test1"
                [x, y] = participantSeries(tr, "test1", "hand");
            case "test2"
                [x, y] = participantSeries(tr, "test2", "hand");
            case "shared"
                [x, y] = sharedSeries(tr);
            otherwise
                x = [];
                y = [];
        end

        plotTrajectory(ax, x, y, lineColor, alphaValue, lineWidthValue);
        plotEndMarker(ax, x, y, lineColor);

        if row == 1 || row == 4
            title(ax, sprintf("%d", trNo), "FontSize", 7, "FontWeight", "normal");
        end
    end

    function initializeAnimation()
        cla(axAnim);
        hold(axAnim, "on");
        formatTrajectoryAxes(axAnim, true);

        animState.currentTrialIndex = trialList.Value;
        animState.currentFrame = 1;
        tr = trialData(animState.currentTrialIndex);

        n = numel(tr.timeFromTrialStartSec);
        animState.handles.targetLine = safePlotLine(axAnim, nan, nan, black, 1.0, 1.5);
        animState.handles.p1HandLine = safePlotLine(axAnim, nan, nan, red, 0.60, 3.0);
        animState.handles.p1CursorLine = safePlotLine(axAnim, nan, nan, paleRed, 0.45, 2.2);
        animState.handles.p2HandLine = safePlotLine(axAnim, nan, nan, blue, 0.60, 3.0);
        animState.handles.p2CursorLine = safePlotLine(axAnim, nan, nan, paleBlue, 0.45, 2.2);
        animState.handles.sharedLine = safePlotLine(axAnim, nan, nan, green, 0.55, 3.0);

        animState.handles.targetDot = plot(axAnim, nan, nan, "o", "Color", black, "MarkerFaceColor", black, "MarkerSize", 5);
        animState.handles.p1HandDot = plot(axAnim, nan, nan, "o", "Color", red, "MarkerFaceColor", red, "MarkerSize", 6);
        animState.handles.p1CursorDot = plot(axAnim, nan, nan, "o", "Color", paleRed, "MarkerFaceColor", paleRed, "MarkerSize", 5);
        animState.handles.p2HandDot = plot(axAnim, nan, nan, "o", "Color", blue, "MarkerFaceColor", blue, "MarkerSize", 6);
        animState.handles.p2CursorDot = plot(axAnim, nan, nan, "o", "Color", paleBlue, "MarkerFaceColor", paleBlue, "MarkerSize", 5);
        animState.handles.sharedDot = plot(axAnim, nan, nan, "o", "Color", green, "MarkerFaceColor", green, "MarkerSize", 6);

        title(axAnim, sprintf("Animation: Trial %d (%d frames)", tr.trialNumber, n), "FontSize", 12);
        updateAnimationFrame();
    end

    function updateAnimationFrame()
        tr = trialData(animState.currentTrialIndex);
        n = numel(tr.timeFromTrialStartSec);
        if n == 0
            return;
        end

        k = min(max(1, animState.currentFrame), n);
        [targetAnimX, targetAnimY] = targetSeries(tr, "shared");
        setLayer(animState.handles.targetLine, animState.handles.targetDot, targetAnimX, targetAnimY, k, targetCheck.Value);
        [p1HandX, p1HandY] = participantSeries(tr, "test1", "hand");
        [p1CursorX, p1CursorY] = participantSeries(tr, "test1", "cursor");
        [p2HandX, p2HandY] = participantSeries(tr, "test2", "hand");
        [p2CursorX, p2CursorY] = participantSeries(tr, "test2", "cursor");
        setLayer(animState.handles.p1HandLine, animState.handles.p1HandDot, p1HandX, p1HandY, k, p1HandCheck.Value);
        setLayer(animState.handles.p1CursorLine, animState.handles.p1CursorDot, p1CursorX, p1CursorY, k, p1CursorCheck.Value);
        setLayer(animState.handles.p2HandLine, animState.handles.p2HandDot, p2HandX, p2HandY, k, p2HandCheck.Value);
        setLayer(animState.handles.p2CursorLine, animState.handles.p2CursorDot, p2CursorX, p2CursorY, k, p2CursorCheck.Value);
        [sharedX, sharedY] = sharedSeries(tr);
        setLayer(animState.handles.sharedLine, animState.handles.sharedDot, sharedX, sharedY, k, sharedCheck.Value);

        t = tr.timeFromTrialStartSec(k);
        if isnan(t)
            t = 0;
        end
        timeText.String = sprintf("t = %.2f s", t);
        drawnow limitrate;
    end

    function setLayer(lineHandle, dotHandle, x, y, k, isVisible)
        if ~isVisible || isempty(x) || isempty(y)
            set(lineHandle, "XData", nan, "YData", nan);
            set(dotHandle, "XData", nan, "YData", nan);
            return;
        end
        kk = min(k, min(numel(x), numel(y)));
        set(lineHandle, "XData", x(1:kk), "YData", y(1:kk));
        if kk >= 1 && isfinite(x(kk)) && isfinite(y(kk))
            set(dotHandle, "XData", x(kk), "YData", y(kk));
        else
            set(dotHandle, "XData", nan, "YData", nan);
        end
    end

    function onTimerTick(~, ~)
        tr = trialData(animState.currentTrialIndex);
        n = numel(tr.timeFromTrialStartSec);
        step = max(1, round(animState.speed));
        animState.currentFrame = animState.currentFrame + step;
        if animState.currentFrame > n
            animState.currentFrame = n;
            playButton.Value = 0;
            playButton.String = "Play";
            stop(timerObj);
        end
        updateAnimationFrame();
    end

    function onPlayToggled(src, ~)
        if src.Value == 1
            src.String = "Pause";
            if strcmp(timerObj.Running, "off")
                start(timerObj);
            end
        else
            src.String = "Play";
            if strcmp(timerObj.Running, "on")
                stop(timerObj);
            end
        end
    end

    function onReset(~, ~)
        animState.currentFrame = 1;
        updateAnimationFrame();
    end

    function onTrialChanged(~, ~)
        if strcmp(timerObj.Running, "on")
            stop(timerObj);
        end
        playButton.Value = 0;
        playButton.String = "Play";
        initializeAnimation();
    end

    function onClose(~, ~)
        if isvalid(timerObj)
            if strcmp(timerObj.Running, "on")
                stop(timerObj);
            end
            delete(timerObj);
        end
        delete(fig);
    end

    function cb = makeCheck(label, x, y, value, color)
        cb = uicontrol(fig, "Style", "checkbox", "Units", "normalized", ...
            "Position", [x, y, 0.135, 0.030], ...
            "String", label, "Value", value, ...
            "ForegroundColor", color, "BackgroundColor", "w", ...
            "Callback", @(~, ~) updateAnimationFrame());
    end

    function tr = getTrial(trNo)
        idx = find([trialData.trialNumber] == trNo, 1, "first");
        if isempty(idx)
            tr = [];
        else
            tr = trialData(idx);
        end
    end

    function addRowLabel(layoutObj, row, label)
        ax = nexttile(layoutObj, tileIndex(row, 1));
        yl = ylabel(ax, label, "FontSize", 8, "FontWeight", "bold");
        yl.Visible = "on";
    end

    function [x, y] = participantSeries(tr, participantName, seriesKind)
        if seriesKind == "hand"
            x = firstExistingField(tr, participantName + "_HandX", participantName + "_CursorX", participantName + "_cursorX");
            y = firstExistingField(tr, participantName + "_HandY", participantName + "_CursorY", participantName + "_cursorY");
        else
            x = firstExistingField(tr, participantName + "_CursorX", participantName + "_cursorX", participantName + "_HandX");
            y = firstExistingField(tr, participantName + "_CursorY", participantName + "_cursorY", participantName + "_HandY");
        end
        if participantName == "test2" && shouldRotateParticipant2ForTask8(tr)
            [x, y] = rotateClockwise90AroundCenter(x, y);
        end
    end

    function [x, y] = sharedSeries(tr)
        if shouldRotateParticipant2ForTask8(tr)
            [~, p1HandY] = participantSeries(tr, "test1", "hand");
            [p2HandX, ~] = participantSeries(tr, "test2", "hand");
            if viewConfig.task8SharedScale == "half"
                x = 0.5 + 0.5 * (p2HandX - 0.5);
                y = 0.5 + 0.5 * (p1HandY - 0.5);
            else
                x = p2HandX;
                y = p1HandY;
            end
        else
            x = firstExistingField(tr, "sharedCursorX");
            y = firstExistingField(tr, "sharedCursorY");
        end
    end

    function [x, y] = targetSeries(tr, dataKind)
        switch string(dataKind)
            case "test1"
                x = firstExistingField(tr, "test1_targetX", "targetX");
                y = firstExistingField(tr, "test1_targetY", "targetY");
            case "test2"
                x = firstExistingField(tr, "test2_targetX", "targetX");
                y = firstExistingField(tr, "test2_targetY", "targetY");
            otherwise
                x = firstExistingField(tr, "test1_targetX", "targetX");
                y = firstExistingField(tr, "test1_targetY", "targetY");
        end
    end

    function value = firstExistingField(s, varargin)
        value = [];
        for ii = 1:numel(varargin)
            fieldName = char(varargin{ii});
            if isfield(s, fieldName)
                value = s.(fieldName);
                return;
            end
        end
    end

    function tf = shouldRotateParticipant2ForTask8(tr)
        isSharedPhase = fieldTextEquals(tr, "phase", "shared");
        if ~isSharedPhase && isfield(tr, "trialNumber")
            isSharedPhase = any(tr.trialNumber == viewConfig.sharedTrialNumbers);
        end
        tf = viewConfig.rotateParticipant2 && isSharedPhase;
    end

    function tf = fieldTextEquals(s, fieldName, expected)
        tf = false;
        if ~isfield(s, fieldName)
            return;
        end
        values = string(s.(fieldName));
        values = values(strlength(values) > 0 & values ~= "missing" & values ~= "unknown");
        tf = any(values == expected);
    end

    function [xr, yr] = rotateClockwise90AroundCenter(x, y)
        xr = y;
        yr = 1 - x;
    end
end

function viewConfig = resolveViewConfig(trialwiseMatPath, trialData, viewOptions)
viewConfig = struct();
viewConfig.groupNumber = groupNumberFromOptionsOrPath(viewOptions, trialwiseMatPath);
viewConfig.rotateParticipant2 = false;
viewConfig.task8SharedScale = "recorded";

if viewConfig.groupNumber >= 5 && viewConfig.groupNumber <= 7
    viewConfig.rotateParticipant2 = true;
    viewConfig.task8SharedScale = "half";
elseif viewConfig.groupNumber >= 8 && viewConfig.groupNumber <= 12
    viewConfig.rotateParticipant2 = true;
    viewConfig.task8SharedScale = "full";
elseif viewConfig.groupNumber >= 1 && viewConfig.groupNumber <= 4
    viewConfig.rotateParticipant2 = false;
    viewConfig.task8SharedScale = "recorded";
else
    % Fallback for manually selected files outside g1-g12.
    isTask8 = any(arrayfun(@(tr) localFieldTextEquals(tr, "taskType", "task8") ...
        || localFieldTextEquals(tr, "cursorDisturbanceType", "axis-aligned-gain-plus-rotation"), trialData));
    if isTask8
        viewConfig.rotateParticipant2 = true;
        viewConfig.task8SharedScale = "full";
    end
end
end

function phaseTrials = inferPhaseTrials(trialData, viewConfig)
trialNumbers = [trialData.trialNumber];
nTrials = numel(trialNumbers);

if isstruct(viewConfig) ...
        && isfield(viewConfig, "baselinePreTrialNumbers") ...
        && isfield(viewConfig, "sharedTrialNumbers") ...
        && isfield(viewConfig, "baselinePostTrialNumbers")
    phaseTrials.baselinePreTrialNumbers = viewConfig.baselinePreTrialNumbers;
    phaseTrials.sharedTrialNumbers = viewConfig.sharedTrialNumbers;
    phaseTrials.baselinePostTrialNumbers = viewConfig.baselinePostTrialNumbers;
    return;
end

sharedMask = false(1, nTrials);
for ti = 1:nTrials
    sharedMask(ti) = localFieldTextEquals(trialData(ti), "phase", "shared");
end

if any(sharedMask)
    firstShared = find(sharedMask, 1, "first");
    lastShared = find(sharedMask, 1, "last");
    phaseTrials.baselinePreTrialNumbers = trialNumbers(1:firstShared - 1);
    phaseTrials.sharedTrialNumbers = trialNumbers(firstShared:lastShared);
    phaseTrials.baselinePostTrialNumbers = trialNumbers(lastShared + 1:end);
    return;
end

if nTrials == 30
    nPre = 5;
    nShared = 20;
elseif nTrials == 20
    nPre = 3;
    nShared = 14;
else
    nPre = min(5, max(1, floor(nTrials * 0.15)));
    nPost = nPre;
    nShared = max(0, nTrials - nPre - nPost);
end

nPre = min(nPre, nTrials);
nShared = min(nShared, max(0, nTrials - nPre));
nPostStart = nPre + nShared + 1;

phaseTrials.baselinePreTrialNumbers = trialNumbers(1:nPre);
phaseTrials.sharedTrialNumbers = trialNumbers(nPre + 1:nPre + nShared);
phaseTrials.baselinePostTrialNumbers = trialNumbers(nPostStart:end);
end

function idx = defaultAnimationTrialIndex(trialData, phaseTrials)
trialNumbers = [trialData.trialNumber];
if ~isempty(phaseTrials.sharedTrialNumbers)
    idx = find(trialNumbers == phaseTrials.sharedTrialNumbers(1), 1, "first");
else
    idx = 1;
end
if isempty(idx)
    idx = min(1, numel(trialNumbers));
end
end

function groupNumber = groupNumberFromOptionsOrPath(viewOptions, trialwiseMatPath)
groupNumber = nan;
if isstruct(viewOptions) && isfield(viewOptions, "groupNumber") && isnumeric(viewOptions.groupNumber)
    groupNumber = viewOptions.groupNumber;
    return;
end
tokens = regexp(string(trialwiseMatPath), "g(\d+)_trialwise\.mat", "tokens", "once");
if ~isempty(tokens)
    groupNumber = str2double(tokens{1});
end
end

function tf = localFieldTextEquals(s, fieldName, expected)
tf = false;
if ~isfield(s, fieldName)
    return;
end
values = string(s.(fieldName));
values = values(strlength(values) > 0 & values ~= "missing" & values ~= "unknown");
tf = any(values == expected);
end

function idx = tileIndex(row, col)
idx = (row - 1) * 20 + col;
end

function formatTrajectoryAxes(ax, showTicks)
xlim(ax, [0 1]);
ylim(ax, [0 1]);
axis(ax, "square");
set(ax, "YDir", "reverse");
box(ax, "on");
if ~showTicks
    ax.XTick = [];
    ax.YTick = [];
else
    grid(ax, "on");
    xlabel(ax, "x");
    ylabel(ax, "y");
end
end

function plotTrajectory(ax, x, y, color, alphaValue, lineWidthValue)
if isempty(x) || isempty(y)
    return;
end
safePlotLine(ax, x, y, color, alphaValue, lineWidthValue);
end

function plotEndMarker(ax, x, y, color)
if isempty(x) || isempty(y)
    return;
end
validIdx = find(isfinite(x) & isfinite(y), 1, "last");
if isempty(validIdx)
    return;
end
plot(ax, x(validIdx), y(validIdx), "o", ...
    "Color", color, ...
    "MarkerFaceColor", color, ...
    "MarkerSize", 3.5);
end

function c = colorWithAlpha(rgb, alphaValue)
% Recent MATLAB versions accept RGBA line colors. If an older version does
% not, MATLAB will error when plotting; use RGB by changing this to rgb.
c = [rgb alphaValue];
end

function h = safePlotLine(ax, x, y, rgb, alphaValue, lineWidthValue)
try
    h = plot(ax, x, y, "-", ...
        "Color", colorWithAlpha(rgb, alphaValue), ...
        "LineWidth", lineWidthValue);
catch
    h = plot(ax, x, y, "-", ...
        "Color", rgb, ...
        "LineWidth", lineWidthValue);
end
end
