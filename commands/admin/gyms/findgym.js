const commando = require('discord.js-commando'),
  Discord = require('discord.js'),
  oneLine = require('common-tags').oneLine,
  Region = require('../../../app/region'),
  PartyManager = require('../../../app/party-manager'),
  Gym = require('../../../app/gym'),
  Helper = require('../../../app/helper'),
  {CommandGroup} = require('../../../app/constants');

module.exports = class FindGym extends commando.Command {
	constructor(client) {
		super(client, {
			name: 'findgym',
			aliases: ['find-gym', 'fort'],
			group: CommandGroup.REGION,
			memberName: 'gym',
			description: 'Find a gym in the region.',
			details: oneLine `
				This command will find a gym based on your search term within the region defined by this channel.
			`,
			examples: ['\tfindgym dog stop'],
			args: [{
				key: 'term',
				prompt: 'Provide a name or search phrase for the gym you are looking for...',
				type: 'string'
			}]
		});

		client.dispatcher.addInhibitor(message => {
			if (!!message.command && message.command.name === 'findgym') {

        if(!Helper.isBotChannel(message) && !Helper.isChannelBounded(message.channel.id,PartyManager.getRaidChannelCache())) {
          return ['invalid-channel', message.reply('Find gyms from regional channels or a bot channel.')];
        }

			}
			return false;
		});
	}

	async run(msg, args) {
		var gym;
		var isID = false;
		let isModLab = msg.channel.name === "mod-bot-lab";
		let isBotLab = msg.channel.name.includes("bot-lab");

		if (this.getValue(args.term) > -1) {
			isID = true;
			gym = await Region.getGym(this.getValue(args.term)).catch(error => msg.say(error));
		} else {
      const results = await Gym.search(isBotLab ? null : msg.channel.id, args.term.split(/\s/g), false);
      if(results.length > 0) {
        gym = results[0].gym;
      }
		}

		if (gym != undefined && gym["name"]) {
      const channels = await Region.getChannelsForGym(gym).catch(error => []);
      const phrase = isID ? "Gym found with ID " + args.term : "Gym found with term '" + args.term + "'";
      await Region.showGymDetail(msg, gym, phrase, null, false);

      var channelStrings = [];
      for(var i=0;i<channels.length;i++) {
        let channel= await PartyManager.getChannel(channels[i].channel_id);
        channelStrings.push(channel.channel.toString());
      }

      if(channelStrings.length > 0) {
        msg.say("This gym is in " + channelStrings.join(", "));
      } else {
        msg.say("This gym is not located in any region channels");
      }

		} else {
			if (isID) {
				msg.reply("No gym found with ID " + args.term);
			} else {
        msg.reply("No gyms found with search term: " + args.term);
      }
		}
	}

	getValue(value) {
		const first = value.substring(0, 1)
		if (first === "#") {
			const integer = value.substring(1, value.length)
			if (Number(integer)) {
				return Number(integer)
			}
		}

		return -1
	}

};
