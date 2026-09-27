# 概要

エージェントに搭載して欲しい機能についての指示書


## エージェント実行前の設定

- 参加者が集まるまでは常にInstructionとTarget Tracking(三角形がランダムに現れるもの)
    - 新しく後から参加した参加者にも，三角形が見えるようになっているかプログラムを確認すること．．
- Display Settingsは常にSelf Only.
- インストラクションとして，以下を5秒ずつ切り替えて表示する．
    - We are waiting for other participants to join. The experiment will begin in a few minutes.
    - Until the main task begins, please continue moving your cursor to the triangular targets appearing on the screen.
- どのタスクを実施するか選ぶ
    1. Circle Target Tracking
    2. Guide Tracking
    3. Non-guide tracking
- 試行数を決める．整数．デフォルト5試行．
- 1試行の秒数を決める．整数．デフォルト20秒．
- 待ち時間を決める．整数．デフォルト10分．
    - 例えば，10人で実施する実験を想定する．10人集まったらその瞬間に実験を開始．10分経ったら，10人いなくても実験を始める．
- デフォルトのDisplay Settingsは，Self Onlyにする．

エージェントがスタートしてから，全ての挙動を開始する．

## 人数が集まってから，実験が開始した際の共通インストラクション．

各インストラクションの時間は調整できるようにする．デフォルト4秒．また，一つのインストラクションが始まるたびにYes/Noエリアを表示する．また，各インストラクションでDisplay Settingsを選択する．さらに，その時の追加アクションを指定できるようにする．以下の項目では，インストラクションとそのときのDisplay Settings，追加アクションを指定する．

1. Thank you for your participation. The main task will now begin. | Self Only
2. Your cursor is now visible. | Self Only
3. We need to switch your cursor to the virtual cursor used for this experiment. | Self Only
4. Please click the center of the screen. Your system pointer will be locked, and it will switch to the virtual cursor within the experimental area. | Self Only | Show Click Area Overlay, and turn on "Use Virtual Cursor for Average"
5. Pressing the Esc key will unlock the pointer, so please do not press it during the experiment. | Self Only | Show Click Area Overlay
6. After the end of experiment, your system pointer will be back. | Self Only | Hide Click Area Overlay
7. The cursor of other participants will now be displayed on the screen. Can you see other participants\' cursors? | All Cursors without Avg cursor
8. Next we will display the "Average Cursor" to be used in the experiment. | All cursors and Average Cursor without Lines | 
9. The Average Cursor represents the mean position of all participants\' cursors. | All cursors and Average Cursor without Lines | 
10. In the upcoming task, only this Average Cursor will be displayed. | All cursors and Average Cursor without Lines | 
11. We will now hide the Average Cursor and the other participants\' cursor before explaining the task. | Self Only

ここまでは共通である．以降は，タスクごとにインストラクションが異なる．

## 各実験課題のインストラクション

最初に選択された実験課題で，続くインストラクションが異なる．デフォルト4秒．また，一つのインストラクションが始まるたびにYes/Noエリアを表示する．インストラクション時はまたTask 2: Manual Instruction．各実験課題のインストラクション

### Circle Target Tracking

Display Durationはデフォルトで，指定した試行時間の半分．

1. In this experiment, a target that moves in a circular pattern is displayed on the screen for 10 seconds. | Self only
2. Please use the average cursor to track this target accurately. | Self only
3. After 10 seconds, the target will disappear, but please continue the circular motion for another 10 seconds. | Self Only
4. Please move the average cursor as closely as possible to the target’s movement. | Self Only
5. There are ${toral number of trials} trials in this experiment. | Self Only

### Guide Tracking

円弧のガイドは，指定した試行時間の半分が経過すると非表示になる．

1. In this experiment, an arc guide will be displayed on the screen for 10 seconds. | Self only
2. Please use the average cursor to trace this guide precisely. | Self Only
3. After 10 seconds, the guide will disappear, but please continue the circular motion for another 10 seconds. | Self Only
4. Please try to move the cursor in the same way you traced the guide. | Self Only
5. There are ${toral number of trials} trials in this experiment. | Self Only

### Non-guide tracking

1. In this experiment, please move the cursor in a circular motion on the screen for 20 seconds. | Self Only
2. There are no specific instructions regarding the direction, speed, or size of the movement. | Self Only
3. Please try to make the circular motion as smooth as possible. | Self Only
4. There are ${toral number of trials} trials in this experiment. | Self Only


## 実験開始後の挙動．全ての課題で共通．

実験課題のインストラクションが終了してから5秒後，実験を開始する．
- Circle Target Trackingの場合は，Task ControlでTask 3: Circle Target Trackingを選択．
- Guide Trackingの場合は，Task ControlでTask 4: Guide Trackingを選択．
- Non-guide trackingの場合は，Task Controlで Task 2: Manual Instructionを選択．

以下が，実験課題に移行してから，実際の各試行でやって欲しい挙動です．

1. "Task will start soon (1st trial)"のように，メッセージを実験ステージの下に3秒表示．
2. Display SettingsをAvg Onlyに切り替え，Virtual Cursor SettingsでReset Position，さらにデータの記録を開始．
3. 20秒間，各実験課題を実施．
4. 各試行終了後，"This trial is now complete"と下に表示．データの記録をストップ，アップロード開始．Display SettingsをSelf Onlyに切り替え．Virtual Cursor SettingsでReset Positionを駆動，
5. データのアップロード完了後，"Next task will start soon (2nd trial)"のようにメッセージを3秒表示，次の試行へ．
6. 各試行では必ず初めに， Display SettingsをAvg Onlyに切り替え，Virtual Cursor SettingsでReset Position，さらにデータの記録を開始すること．
7. 各試行が終了するごとに，必ずデータの記録をストップ，アップロード開始．Display SettingsをSelf Onlyに切り替え．Virtual Cursor SettingsでReset Positionを駆動，


## 最後の試行が終わった後のインストラクション

最終試行が終わった後のインストラクションは共通である．

1. All trial now completeとメッセージを表示．
2. The experiment ends, Thank you for your participationとメッセージを表示，Display Settingsを　All Cursors without avg cursorにする．
3. You will now be redirected to reward page. を5秒表示して，End Sessionする．

