const testInput = [
    [1653, 1334204],
    [1655, 551617],
    [1643, 550000],
    [1669,20]
];

function rankPrice(slag) {
    const ourCode = 1643;
    let isLeader = false;
    let output = {
        partNumber: null,
        brandName: null,
        rankPos: null,
        ourPrice: null,
        leaderCode: null,
        leaderPrice: null,
        overPrice: null,
        overCode: null,
        underPrice: null,
        underCode: null
    };

    // Sort the array based on the second number (price) in ascending order
    slag.sort((a, b) => a[1] - b[1]);

    // Loop through the sorted array to add positions and find our data
    for (let i = 0; i < slag.length; i++) {
        const pos = i + 1;
        slag[i].push(pos);

        // Find our data
        if (slag[i][0] === ourCode) {
            output.rankPos = slag[i][2];
            output.ourPrice = slag[i][1];
        }
    }

    // After the loop, find the "leader" (rank 1) and the "under" price (one rank lower than us)
    const leaderArray = slag.find(item => item[2] === 1);
    const underArray = slag.find(item => item[2] === output.rankPos + 1);
    const overArray = slag.find(item => item[2] === output.rankPos - 1);

    // Leader data
    if (leaderArray && leaderArray[0] === ourCode) {
        isLeader = true;
    }

    if (isLeader) {
        output.leaderCode = 'G&G лидер по позиции';
        output.leaderPrice = output.ourPrice;
        output.overCode = 'G&G лидер по позиции';
        output.overPrice = 'G&G лидер по позиции';

    } else if (leaderArray) {
        output.leaderCode = leaderArray[0];
        output.leaderPrice = leaderArray[1];
    }
    
    // Under price data
    // This is the new logic you asked for
    if (underArray) {
        output.underCode = underArray[0];
        output.underPrice = underArray[1];
    }

    if (overArray) {
        output.overCode = overArray[0];
        output.overPrice = overArray[1];
    }


    return output;
}

console.log(rankPrice(testInput));